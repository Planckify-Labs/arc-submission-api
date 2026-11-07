import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, UnrecoverableError } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { PushService } from "../../push/push.service";
import { BlockchainVerificationService } from "../../blockchain-verification/blockchain-verification.service";
import {
  classifySettlementError,
  resolveMinConfirmations,
  settlementBackoffStrategy,
} from "../../blockchain-verification/settlement-policy";
import { VendorRegistry } from "../../providers/vendor-api/vendor-registry.service";
import { ReferenceIdService } from "../../reference-id/reference-id.service";
import { BlockchainCacheService } from "../../valkey/services/blockchain-cache.service";
import { SmartContractCacheService } from "../../valkey/services/smart-contract-cache.service";
import { TokenCacheService } from "../../valkey/services/token-cache.service";
import { addressesEqual } from "../../auth/address-compare";
import { FulfilmentService } from "../../fulfilment/fulfilment.service";
import {
  TPurchaseJobData,
  TPurchaseStatusUpdate,
} from "../interfaces/job-data.interface";
import {
  PurchaseStatus,
  TransactionType,
  TransactionStatus,
  Prisma,
} from "@generated/prisma";
import { BookingStatus } from "../../booking/enums/booking-status.enum";
import { BOOKING_PAYMENT_GRACE_MS } from "../../booking/booking.constants";
import { PointsHoldService } from "../../points-hold/points-hold.service";
import { TBookingWithRelations } from "../types/booking.types";

/**
 * How many times the post-payment stage (vendor order and what follows it)
 * may fail before the order is handed to the fulfilment leg's retries-
 * exhausted path. This is NOT the job's attempt budget: verification waits
 * for the chain on the long settlement schedule (`SETTLEMENT_MAX_ATTEMPTS`),
 * and those attempts must never turn into vendor orders.
 */
export const VENDOR_STAGE_MAX_ATTEMPTS = 3;

export { BOOKING_PAYMENT_GRACE_MS };

/**
 * Outcome rules follow `settlement-policy.ts`: the buyer is told the payment
 * failed only when the CHAIN said so (reverted, or a mined record that is not
 * the booked payment). Anything on our side (RPC down, receipt not there yet)
 * is retried silently on the long schedule, and a job that is still without a
 * verdict at the end goes to ops, not to FAILED.
 */
@Processor("purchase-processing", {
  concurrency: 10,
  settings: { backoffStrategy: settlementBackoffStrategy },
})
export class PurchaseProcessor extends WorkerHost {
  private readonly logger = new Logger(PurchaseProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchainVerificationService: BlockchainVerificationService,
    private readonly vendors: VendorRegistry,
    private readonly referenceIdService: ReferenceIdService,
    private readonly blockchainCache: BlockchainCacheService,
    private readonly contractCache: SmartContractCacheService,
    private readonly tokenCache: TokenCacheService,
    private readonly pushService: PushService,
    private readonly fulfilment: FulfilmentService,
    private readonly config: ConfigService,
    private readonly holds: PointsHoldService,
  ) {
    super();
  }

  async process(job: Job<TPurchaseJobData>): Promise<{
    success: boolean;
    purchaseId?: string;
    transactionId?: string;
  }> {
    const {
      refId,
      bookingId,
      walletAddress,
      networkId,
      contractAddress,
      transactionHash,
      purchaseId,
    } = job.data;

    this.logger.log(`Processing purchase job ${job.id} for refId: ${refId}`);

    // What happens on failure depends on how far we got: before the chain
    // verified the payment nothing was delivered and the charge is in doubt;
    // after it, they HAVE paid and the vendor is our problem.
    let paymentVerified = false;
    let stage: "prepare" | "verify" = "prepare";
    let productName: string | null = null;
    // Whether `createOrder` was called at all, on this attempt or an earlier
    // one (persisted in the job data). Decides, once retries are gone,
    // between "refund — the vendor never heard of this" and "ops — an order
    // may exist on the vendor side".
    let orderAttempted = job.data.vendorOrderAttempted === true;

    try {
      const existingPurchase = await this.prisma.purchase.findUnique({
        where: { id: purchaseId },
      });

      if (!existingPurchase) {
        throw new Error(`Purchase with ID ${purchaseId} not found`);
      }
      if (existingPurchase.vendorRefId) orderAttempted = true;

      await this.updatePurchaseStatus(refId, {
        refId,
        purchaseId,
        status: "processing",
        stage: "validation",
        message: "Validating booking and preparing for blockchain verification",
      });

      const booking = await this.validateAndPrepareBooking(
        bookingId,
        walletAddress,
        networkId,
        contractAddress,
      );
      productName = booking.productVariant.product.name;

      await this.prisma.purchase.update({
        where: { id: purchaseId },
        data: { status: PurchaseStatus.PENDING },
      });

      await this.updatePurchaseStatus(refId, {
        refId,
        purchaseId,
        status: "pending",
        stage: "blockchain_verification",
        message: "Verifying blockchain transaction",
      });

      if (!refId) {
        throw new Error("RefId is required for transaction verification");
      }
      if (!contractAddress) {
        throw new Error(
          "Contract address is required for transaction verification",
        );
      }

      stage = "verify";
      const verification = await this.verifyBlockchainTransaction({
        transactionHash,
        expectedSender: walletAddress,
        expectedRecipient: contractAddress,
        expectedTokenAddress: booking.payment.tokenAddress,
        expectedChainId: booking.blockchain.chainId ?? 0,
        refId,
        contractAddress,
        expectedBookingId: booking.id,
        expectedExchangeRateId:
          (
            booking.exchangeRate as { id?: number | string } | null
          )?.id?.toString() || "0",
        expectedProductVariantId: booking.productVariantId,
        expectedAmount: booking.payment.amount,
        blockchainId: booking.blockchain.id,
        minimumConfirmations: resolveMinConfirmations(
          booking.blockchain,
          this.config,
        ),
      });

      paymentVerified = true;

      const transaction = await this.prisma.transactionHistory.update({
        where: {
          id_createdAt: {
            id: existingPurchase.transactionId,
            createdAt: existingPurchase.transactionCreatedAt,
          },
        },
        data: {
          status: TransactionStatus.CONFIRMED,
        },
      });

      await this.updatePurchaseStatus(refId, {
        refId,
        purchaseId,
        status: "blockchain_verified",
        stage: "blockchain_verified",
        message: "Blockchain transaction verified successfully",
      });

      // The booking lock is judged by CHAIN time only: when the contract
      // recorded the payment, never when we got the POST or processed it. A
      // payment mined in time but confirmed slowly, or delivered late by the
      // mobile outbox, is fulfilled even if the row is already EXPIRED. Once
      // an order is attempted (or accepted) this was already decided.
      if (!orderAttempted) {
        const problem = this.paymentWindowProblem(
          booking.status,
          booking.expiresAt,
          verification.recordTimestamp,
        );
        if (problem === "no_timestamp") {
          // Not evidence of a late payment: ops decides, never a refund.
          await this.fulfilment.onPaymentUnverified(
            "purchase",
            purchaseId,
            "contract record carried no timestamp; cannot judge the booking window",
          );
          return { success: false, purchaseId, transactionId: transaction.id };
        }
        if (problem) {
          // The money arrived (the transaction row stays CONFIRMED) but the
          // booking was gone: no vendor order, points refund and push via the
          // fulfilment leg, no retries. Both writes below are idempotent, so
          // a redelivered job repeats nothing. The refund also settles any
          // held points (HELD -> CONSUMED, returned with the token part).
          await this.refundWithoutOrder({
            errorType: "booking_expired",
            message: problem,
            refId,
            purchaseId,
            bookingId,
            walletAddress,
          });
          return { success: false, purchaseId, transactionId: transaction.id };
        }

        // The payment is in time: the points held for it are now spent for
        // good (HELD -> CONSUMED; already CONSUMED on a retry, NONE when the
        // booking used no points). If the sweep released them first, the
        // buyer already has those points back, so the order must not run;
        // the token part is refunded and the buyer stays whole.
        const hold = await this.holds.consume(bookingId);
        if (hold === "RELEASED") {
          await this.refundWithoutOrder({
            errorType: "points_hold_released",
            message:
              "the points held for this booking were released before the payment arrived",
            refId,
            purchaseId,
            bookingId,
            walletAddress,
          });
          return { success: false, purchaseId, transactionId: transaction.id };
        }
      }

      // Any vendor with an adapter is fulfilled the same way; the adapter
      // is resolved from the price row, never named here.
      if (this.vendors.has(booking.productPrice?.vendor?.name)) {
        const accepted = await this.processVendorOrder(
          purchaseId,
          booking as unknown as TBookingWithRelations,
          refId,
          existingPurchase.vendorRefId,
          () => {
            orderAttempted = true;
          },
        );
        if (!accepted) {
          // Definitive vendor rejection: the fulfilment leg has already
          // marked the purchase FAILED and started the refund. Nothing to
          // retry, nothing to complete.
          await this.referenceIdService.markAsFailed(refId, {
            requestType: "PURCHASE",
            walletAddress,
            bookingId,
            purchaseId,
            error: "Vendor rejected the order",
            errorType: "vendor_rejected",
          });
          return { success: false, purchaseId, transactionId: transaction.id };
        }
        // Accepted. Whether the product actually arrives is the
        // fulfilment leg's job from here — it sends the "preparing" push
        // now and "ready" only once the vendor confirms.
        await this.fulfilment.onVendorAccepted("purchase", purchaseId);
      }

      await this.prisma.bookingOrder.update({
        where: { id: bookingId },
        data: { status: BookingStatus.EXECUTED },
      });

      // Money leg done: paid, and the vendor has the order.
      await this.prisma.purchase.update({
        where: { id: purchaseId },
        data: { status: PurchaseStatus.COMPLETED },
      });

      await this.updatePurchaseStatus(refId, {
        refId,
        purchaseId,
        status: "completed",
        stage: "completed",
        message: "Purchase completed successfully",
      });

      await this.referenceIdService.markAsCompleted(refId, {
        requestType: "PURCHASE",
        walletAddress,
        bookingId,
        purchaseId,
        vendorName: booking.productPrice?.vendor?.name,
        vendorId: booking.productPrice?.vendorId,
        productCode: booking.productVariant.product.code,
        productName: booking.productVariant.product.name,
        variantCode: booking.productVariant.variantCode,
        status: "completed_successfully",
      });

      this.logger.log(
        `Purchase job ${job.id} completed successfully for refId: ${refId}`,
      );

      return {
        success: true,
        purchaseId,
        transactionId: transaction.id,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.error(
        `Purchase job ${job.id} failed for refId: ${refId} (attempt ${job.attemptsMade + 1}):`,
        error,
      );

      if (!paymentVerified) {
        // Only a verification error can be a chain verdict. A failure while
        // preparing (booking lookup, DB, config) says nothing about the
        // chain, so it is never classified as one.
        const outcome =
          stage === "verify" ? classifySettlementError(error) : "transient";

        if (outcome !== "transient") {
          // The chain has spoken; retrying cannot change it.
          await this.failOnChainVerdict({
            outcome,
            errorMessage,
            refId,
            purchaseId,
            bookingId,
            walletAddress,
            productName,
          });
          return { success: false, purchaseId };
        }

        // No verdict yet. The purchase stays in progress and BullMQ retries
        // on the long schedule; nothing is recorded as failed and the buyer
        // hears nothing. Out of retries, it is ops' call, not FAILED.
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await this.fulfilment
            .onPaymentUnverified("purchase", purchaseId, errorMessage)
            .catch((err) =>
              this.logger.error(
                `[purchase] hand-off to ops failed for ${purchaseId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
        throw error;
      }

      // They HAVE paid; what failed is the vendor stage. It has its own small
      // budget, counted in the job data because `attemptsMade` also counts
      // every verification attempt before it.
      const vendorAttempts = (job.data.vendorAttempts ?? 0) + 1;
      const exhausted =
        vendorAttempts >= VENDOR_STAGE_MAX_ATTEMPTS ||
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (!exhausted) {
        await job
          .updateData({
            ...job.data,
            vendorAttempts,
            vendorOrderAttempted: orderAttempted,
          })
          .catch((err) =>
            this.logger.warn(
              `[purchase] could not persist vendor attempt count for ${purchaseId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        throw error;
      }

      await this.referenceIdService.markAsFailed(refId, {
        requestType: "PURCHASE",
        walletAddress,
        bookingId,
        purchaseId,
        error: errorMessage,
        errorType: "purchase_processing_error",
      });
      // Refund if the vendor was never reached, hand to ops if an order
      // might exist over there.
      await this.fulfilment
        .onOrderRetriesExhausted("purchase", purchaseId, {
          orderAttempted,
          error: errorMessage,
        })
        .catch((err) =>
          this.logger.error(
            `[purchase] fulfilment settle failed for ${purchaseId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      // Settled. Stop here: with the long job budget a plain rethrow would
      // run the vendor stage again.
      throw new UnrecoverableError(errorMessage);
    }
  }

  /** FAILED (idempotent), reference failed, then the fulfilment leg refunds as points. A failing refund throws so the job retries. */
  private async refundWithoutOrder(input: {
    errorType: "booking_expired" | "points_hold_released";
    message: string;
    refId: string;
    purchaseId: string;
    bookingId: string;
    walletAddress: string;
  }): Promise<void> {
    const { errorType, message, refId, purchaseId, bookingId } = input;
    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: PurchaseStatus.FAILED },
    });
    await this.referenceIdService.markAsFailed(refId, {
      requestType: "PURCHASE",
      walletAddress: input.walletAddress,
      bookingId,
      purchaseId,
      error: message,
      errorType,
    });
    await this.fulfilment.onOrderRetriesExhausted("purchase", purchaseId, {
      orderAttempted: false,
      error: message,
    });
  }

  /**
   * Whether a verified payment still belongs to its booking. Returns a reason
   * string when it does not, "no_timestamp" when it cannot be judged, null
   * when fine. `recordTimestamp` is unix seconds from the contract record.
   */
  private paymentWindowProblem(
    status: string,
    expiresAt: Date,
    recordTimestamp: string | undefined,
  ): string | null {
    if (status === BookingStatus.CANCELLED) {
      return "booking was cancelled before payment was processed";
    }
    const seconds = Number(recordTimestamp ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return "no_timestamp";
    const paidAtMs = seconds * 1000;
    const deadlineMs = expiresAt.getTime() + BOOKING_PAYMENT_GRACE_MS;
    if (paidAtMs > deadlineMs) {
      return `booking expired: payment was mined at ${new Date(paidAtMs).toISOString()}, after ${new Date(deadlineMs).toISOString()}`;
    }
    return null;
  }

  /**
   * The chain refused the payment (reverted) or mined something that is not
   * the booked payment (mismatch). Final for this transaction: FAILED now,
   * no retries, the buyer is told.
   */
  private async failOnChainVerdict(input: {
    outcome: "rejected_reverted" | "rejected_mismatch";
    errorMessage: string;
    refId: string;
    purchaseId: string;
    bookingId: string;
    walletAddress: string;
    productName: string | null;
  }): Promise<void> {
    const { outcome, errorMessage, refId, purchaseId, bookingId } = input;
    this.logger.warn(
      `[purchase] chain verdict ${outcome} for purchase ${purchaseId}: ${errorMessage}`,
    );

    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: PurchaseStatus.FAILED },
    });

    await this.updatePurchaseStatus(refId, {
      refId,
      purchaseId,
      status: "failed",
      stage: "error",
      message: "Purchase processing failed",
      error: errorMessage,
    });

    await this.referenceIdService.markAsFailed(refId, {
      requestType: "PURCHASE",
      walletAddress: input.walletAddress,
      bookingId,
      purchaseId,
      error: errorMessage,
      errorType: "purchase_processing_error",
    });

    // Nothing moved on-chain (or what moved is not this payment): the points
    // held for the booking go back. Idempotent; a failure here throws so the
    // job runs again and releases them.
    await this.holds.release(bookingId, `chain verdict ${outcome}`);

    this.notifyBuyer({
      walletAddress: input.walletAddress,
      purchaseId,
      bookingId,
      productName: input.productName ?? "your order",
      outcome: "payment_failed",
    });
  }

  /** Best-effort: a push problem must never change the purchase outcome. */
  private notifyBuyer(input: {
    walletAddress: string;
    purchaseId: string;
    bookingId: string;
    productName: string;
    outcome: "payment_failed";
  }): void {
    void this.pushService.sendPurchaseOutcomePush(input).catch((err) => {
      this.logger.warn(
        `[purchase] ${input.outcome} push failed for purchase ${input.purchaseId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async validateAndPrepareBooking(
    bookingId: string,
    walletAddress: string,
    networkId: string,
    contractAddress: string,
  ) {
    const booking = await this.prisma.bookingOrder.findUnique({
      where: { id: bookingId },
      include: {
        productVariant: {
          include: { product: true },
        },
        productPrice: {
          include: { vendor: true },
        },
      },
    });

    if (!booking) {
      throw new Error(`Booking with ID ${bookingId} not found`);
    }

    if (!addressesEqual(booking.walletAddress, walletAddress)) {
      throw new Error(
        `Wallet address mismatch: booking belongs to ${booking.walletAddress}`,
      );
    }

    const payment = booking.payment as {
      tokenAddress: string;
      blockchainNetworkId: string;
      amount: string;
    };

    if (payment.blockchainNetworkId !== networkId) {
      throw new Error(
        `Network ID mismatch: booking uses network ${payment.blockchainNetworkId}, but ${networkId} was provided`,
      );
    }

    // Use cache for blockchain lookup (hot path optimization)
    const blockchain = await this.blockchainCache.getById(networkId, () =>
      this.prisma.blockchain.findUnique({
        where: { id: networkId },
      }),
    );

    if (!blockchain || !blockchain.isActive) {
      throw new Error(`Network ${blockchain?.name || networkId} is not active`);
    }

    if (blockchain.type === "EVM") {
      const smartContract = await this.contractCache.getByBlockchainAndAddress(
        networkId,
        contractAddress,
        () =>
          this.prisma.smartContract.findFirst({
            where: {
              blockchainId: networkId,
              address: { equals: contractAddress, mode: "insensitive" },
            },
          }),
      );

      if (!smartContract || !smartContract.isActive) {
        throw new Error(
          `Smart contract with address ${contractAddress} not found or not active`,
        );
      }

      return {
        ...booking,
        payment,
        blockchain,
        smartContract,
      };
    }

    return {
      ...booking,
      payment,
      blockchain,
      smartContract: null,
    };
  }

  private async validateToken(networkId: string, tokenAddress: string) {
    // Use cache for token lookup (hot path optimization)
    const token = await this.tokenCache.getByBlockchainAndAddress(
      networkId,
      tokenAddress,
      () =>
        this.prisma.token.findUnique({
          where: {
            blockchainId_contractAddress: {
              blockchainId: networkId,
              contractAddress: tokenAddress,
            },
          },
        }),
    );

    if (!token) {
      throw new Error(
        `Token with address ${tokenAddress} not found on network`,
      );
    }

    return token;
  }

  private async verifyBlockchainTransaction(args: {
    transactionHash: string;
    expectedSender: string;
    expectedRecipient: string;
    expectedTokenAddress: string;
    expectedChainId: number;
    refId: string;
    contractAddress: string;
    expectedBookingId: string;
    expectedExchangeRateId: string;
    expectedProductVariantId: string;
    expectedAmount: string;
    blockchainId: string;
    minimumConfirmations: number;
  }) {
    const verificationResult =
      await this.blockchainVerificationService.verifyTransaction(args);

    this.logger.log(`Transaction verification successful:`, {
      hash: verificationResult.transactionHash,
      confirmations: verificationResult.confirmations,
      status: verificationResult.status,
      from: verificationResult.from,
      to: verificationResult.to,
    });

    return verificationResult;
  }

  /**
   * Place the vendor order. Returns whether it was ACCEPTED (a
   * `trx_code` exists). A definitive rejection returns false after the
   * fulfilment leg has settled it; an ambiguous failure throws so BullMQ
   * retries (the vendor is expected to dedupe on our `ref_id`).
   */
  private async processVendorOrder(
    purchaseId: string,
    booking: TBookingWithRelations,
    refId: string,
    acceptedVendorRefId: string | null,
    onAttempt: () => void,
  ): Promise<boolean> {
    // A retry after the vendor already accepted (the failure was further
    // along) must not place a second order.
    if (acceptedVendorRefId) {
      this.logger.log(
        `[purchase] ${purchaseId} already has vendor order ${acceptedVendorRefId}; not ordering again`,
      );
      return true;
    }

    await this.updatePurchaseStatus(refId, {
      refId,
      purchaseId,
      status: "vendor_processing",
      stage: "vendor_api_call",
      message: "Processing vendor order",
    });

    const customerInfo = booking.customerInfo;
    if (!customerInfo) {
      throw new Error(
        `Customer information is required for ${booking.productVariant.product.name}`,
      );
    }

    const brandKey = booking.productVariant.product.code;
    const variationKey = booking.productVariant.variantCode;
    const price = Number(booking.productPrice?.priceFromVendor || 0);

    let formData: Array<{ key: string; value: string }>;
    if (Array.isArray(customerInfo)) {
      formData = customerInfo;
    } else {
      formData = Object.entries(
        customerInfo as Record<string, string | number | boolean | string[]>,
      ).map(([key, value]) => ({ key, value: String(value) }));
    }

    if (!formData.length) {
      throw new Error("Required customer information is missing");
    }

    await this.referenceIdService.markAsProcessing(refId, {
      requestType: "PURCHASE",
      walletAddress: booking.walletAddress,
      bookingId: booking.id,
      vendorName: booking.productPrice?.vendor?.name,
      vendorId: booking.productPrice?.vendorId,
      productCode: booking.productVariant.product.code,
      productName: booking.productVariant.product.name,
      variantCode: booking.productVariant.variantCode,
      vendorAction: "creating_order",
    });

    onAttempt();
    const vendor = this.vendors.get(booking.productPrice?.vendor?.name);
    const orderResponse = await vendor.createOrder(
      brandKey,
      variationKey,
      price,
      formData,
      refId,
    );

    const vendorRefId = orderResponse.data?.data?.trx_code;
    if (!orderResponse.success || !vendorRefId) {
      const cls = await this.fulfilment.onVendorRejected(
        "purchase",
        purchaseId,
        orderResponse,
      );
      if (cls === "definitive") return false;
      throw new Error(`Failed to process order: ${orderResponse.message}`);
    }

    const vendorResponse = orderResponse.data as unknown as Prisma.JsonValue;

    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: {
        vendorRefId,
        vendorResponse: vendorResponse as Prisma.InputJsonValue,
      },
    });
    return true;
  }

  private async updatePurchaseStatus(
    refId: string,
    update: TPurchaseStatusUpdate,
  ): Promise<void> {
    this.logger.log(
      `Purchase status update for ${refId}: ${update.status} - ${update.message}`,
    );

    await Promise.resolve();
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully`);
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job, err: Error) {
    this.logger.error(`Job ${job.id} failed:`, err);
  }

  @OnWorkerEvent("progress")
  onProgress(job: Job, progress: number | object) {
    this.logger.log(`Job ${job.id} progress: ${JSON.stringify(progress)}`);
  }
}
