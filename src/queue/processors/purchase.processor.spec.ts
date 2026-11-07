jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import { SETTLEMENT_MAX_ATTEMPTS } from "../../blockchain-verification/settlement-policy";
import {
  BOOKING_PAYMENT_GRACE_MS,
  PurchaseProcessor,
  VENDOR_STAGE_MAX_ATTEMPTS,
} from "./purchase.processor";
import type { TPurchaseJobData } from "../interfaces/job-data.interface";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CONTRACT = "0xC0ffee254729296a45a3885639AC7E10F9d54979";
const BOOKED_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

interface HarnessOpts {
  verify?: jest.Mock;
  bookingStatus?: string;
  bookingWallet?: string;
  vendorRefId?: string | null;
  customerInfo?: unknown;
  /** What `createOrder` answers. Default: accepted. */
  order?: "accepted" | "ambiguous" | "definitive";
  /** Unix seconds the contract recorded the payment; default: in time. */
  recordTimestamp?: number | null;
  /** What `holds.consume` answers. Default: no points were used. */
  hold?: "CONSUMED" | "RELEASED" | "NONE";
}

// The booking's lock ended an hour ago; the payment was mined 5 min before.
const EXPIRES_AT = new Date(Date.now() - 60 * 60 * 1000);
const IN_TIME = Math.floor(EXPIRES_AT.getTime() / 1000) - 300;

function buildHarness(opts: HarnessOpts = {}) {
  const purchaseRow = {
    id: "pur_1",
    transactionId: "tx_1",
    transactionCreatedAt: new Date(),
    vendorRefId: opts.vendorRefId ?? null,
  };
  const booking = {
    id: "book_1",
    walletAddress: opts.bookingWallet ?? WALLET,
    productVariantId: "pv_1",
    status: opts.bookingStatus ?? "PENDING",
    expiresAt: EXPIRES_AT,
    payment: {
      tokenAddress: BOOKED_TOKEN,
      blockchainNetworkId: "bc_1",
      amount: "1000000",
    },
    exchangeRate: { id: 42, rate: 15700 },
    customerInfo: "customerInfo" in opts ? opts.customerInfo : { userId: "1" },
    productVariant: {
      variantCode: "V1",
      product: { code: "P1", name: "Mobile Legends" },
    },
    productPrice: {
      vendorId: "v1",
      priceFromVendor: 1000,
      vendor: { name: "acme" },
    },
  };
  const prisma = {
    purchase: {
      findUnique: jest.fn(async () => purchaseRow),
      update: jest.fn(async (_args: { data: { status?: string } }) => ({})),
    },
    bookingOrder: {
      findUnique: jest.fn(async () => booking),
      update: jest.fn(async () => ({})),
    },
    transactionHistory: { update: jest.fn(async () => ({ id: "tx_1" })) },
  };
  const verification = {
    verifyTransaction:
      opts.verify ??
      jest.fn(async () => ({
        transactionHash: "0xhash",
        confirmations: 3,
        status: "success",
        from: WALLET,
        to: CONTRACT,
        recordTimestamp:
          opts.recordTimestamp === null
            ? undefined
            : String(opts.recordTimestamp ?? IN_TIME),
      })),
  };
  const createOrder = jest.fn(async () => {
    if (opts.order === "ambiguous" || opts.order === "definitive") {
      return { success: false, message: "boom", data: undefined };
    }
    return { success: true, message: "ok", data: { data: { trx_code: "TRX1" } } };
  });
  const vendors = {
    has: jest.fn(() => true),
    get: jest.fn(() => ({ createOrder })),
  };
  const referenceId = {
    markAsProcessing: jest.fn(async () => undefined),
    markAsFailed: jest.fn(async () => undefined),
    markAsCompleted: jest.fn(async () => undefined),
  };
  const chain = {
    id: "bc_1",
    isActive: true,
    type: "EVM",
    chainId: 137,
    minConfirmations: 3,
  };
  const blockchainCache = { getById: jest.fn(async () => chain) };
  const contractCache = {
    getByBlockchainAndAddress: jest.fn(async () => ({ isActive: true })),
  };
  const push = { sendPurchaseOutcomePush: jest.fn(async () => undefined) };
  const fulfilment = {
    onVendorAccepted: jest.fn(async () => undefined),
    onVendorRejected: jest.fn(async () => opts.order ?? "ambiguous"),
    onOrderRetriesExhausted: jest.fn(async () => undefined),
    onPaymentUnverified: jest.fn(async () => undefined),
  };
  const config = { get: jest.fn(() => undefined) };
  const holds = {
    consume: jest.fn(async () => opts.hold ?? "NONE"),
    release: jest.fn(async () => true),
  };

  const processor = new PurchaseProcessor(
    prisma as never,
    verification as never,
    vendors as never,
    referenceId as never,
    blockchainCache as never,
    contractCache as never,
    {} as never,
    push as never,
    fulfilment as never,
    config as unknown as ConfigService,
    holds as never,
  );
  return {
    processor,
    prisma,
    verification,
    createOrder,
    referenceId,
    push,
    fulfilment,
    holds,
  };
}

function makeJob(
  over: {
    attemptsMade?: number;
    attempts?: number;
    data?: Partial<TPurchaseJobData>;
  } = {},
) {
  const job = {
    id: "purchase-ref_1",
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? SETTLEMENT_MAX_ATTEMPTS },
    data: {
      refId: "ref_1",
      bookingId: "book_1",
      walletAddress: WALLET,
      networkId: "bc_1",
      contractAddress: CONTRACT,
      transactionHash: "0xhash",
      userId: "u1",
      tokenId: "t1",
      purchaseId: "pur_1",
      ...over.data,
    } as TPurchaseJobData,
    updateData: jest.fn(async (d: TPurchaseJobData) => {
      job.data = d;
    }),
  };
  return job;
}

const run = (h: ReturnType<typeof buildHarness>, job: ReturnType<typeof makeJob>) =>
  h.processor.process(job as unknown as Job<TPurchaseJobData>);

const failedStatusWrites = (h: ReturnType<typeof buildHarness>) =>
  h.prisma.purchase.update.mock.calls.filter(
    (c) => c[0].data.status === "FAILED",
  );

describe("PurchaseProcessor verification inputs", () => {
  it("verifies against the booked token, not the contract address", async () => {
    const h = buildHarness();
    await run(h, makeJob());
    const req = h.verification.verifyTransaction.mock.calls[0][0];
    expect(req.expectedTokenAddress).toBe(BOOKED_TOKEN);
    expect(req.expectedRecipient).toBe(CONTRACT);
    expect(req.expectedTokenAddress).not.toBe(req.expectedRecipient);
    expect(req.expectedExchangeRateId).toBe("42");
    expect(req.expectedAmount).toBe("1000000");
  });

  it("uses the chain's own confirmation depth instead of a hardcoded 12", async () => {
    const h = buildHarness();
    await run(h, makeJob());
    expect(h.verification.verifyTransaction.mock.calls[0][0].minimumConfirmations).toBe(
      3,
    );
  });
});

describe("PurchaseProcessor chain verdicts", () => {
  it.each([
    ["reverted", "Transaction 0xhash was reverted or failed"],
    ["record mismatch", "Contract token address mismatch: expected 0xA, got 0xB"],
  ])("%s: FAILED now, buyer told, no retry", async (_name, message) => {
    const h = buildHarness({
      verify: jest.fn(async () => {
        throw new BadRequestException(message);
      }),
    });
    const job = makeJob({ attemptsMade: 0 });

    // Resolves (does not throw), so BullMQ does not schedule another attempt.
    await expect(run(h, job)).resolves.toMatchObject({
      success: false,
      purchaseId: "pur_1",
    });

    expect(failedStatusWrites(h)).toHaveLength(1);
    expect(h.referenceId.markAsFailed).toHaveBeenCalledTimes(1);
    expect(h.push.sendPurchaseOutcomePush).toHaveBeenCalledTimes(1);
    expect(h.fulfilment.onPaymentUnverified).not.toHaveBeenCalled();
    expect(h.createOrder).not.toHaveBeenCalled();
  });
});

describe("PurchaseProcessor transient verification failures", () => {
  const transientVerify = () =>
    jest.fn(async () => {
      throw new BadRequestException(
        "Failed to verify transaction 0xhash: Timed out while waiting for transaction",
      );
    });

  it("stays in progress: no FAILED, no push, no failed reference, and it retries", async () => {
    const h = buildHarness({ verify: transientVerify() });
    await expect(run(h, makeJob({ attemptsMade: 3 }))).rejects.toThrow(/Timed out/);

    expect(failedStatusWrites(h)).toHaveLength(0);
    expect(h.referenceId.markAsFailed).not.toHaveBeenCalled();
    expect(h.push.sendPurchaseOutcomePush).not.toHaveBeenCalled();
    expect(h.fulfilment.onPaymentUnverified).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
  });

  it("does not use up the vendor budget", async () => {
    const h = buildHarness({ verify: transientVerify() });
    const job = makeJob({ attemptsMade: 1 });
    await expect(run(h, job)).rejects.toThrow();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("insufficient confirmations is transient, not a verdict", async () => {
    const h = buildHarness({
      verify: jest.fn(async () => {
        throw new BadRequestException("Insufficient confirmations: 2/3");
      }),
    });
    await expect(run(h, makeJob())).rejects.toThrow(/Insufficient/);
    expect(failedStatusWrites(h)).toHaveLength(0);
    expect(h.push.sendPurchaseOutcomePush).not.toHaveBeenCalled();
  });

  it("with the retries spent, hands the purchase to ops instead of FAILED or a refund", async () => {
    const h = buildHarness({ verify: transientVerify() });
    const last = SETTLEMENT_MAX_ATTEMPTS - 1;
    await expect(run(h, makeJob({ attemptsMade: last }))).rejects.toThrow();

    expect(h.fulfilment.onPaymentUnverified).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.stringContaining("Timed out"),
    );
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
    expect(failedStatusWrites(h)).toHaveLength(0);
    expect(h.push.sendPurchaseOutcomePush).not.toHaveBeenCalled();
  });

  it("a preparation failure that merely says 'mismatch' is not a chain verdict", async () => {
    const h = buildHarness({ bookingWallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" });
    await expect(run(h, makeJob())).rejects.toThrow(/Wallet address mismatch/);
    expect(failedStatusWrites(h)).toHaveLength(0);
    expect(h.push.sendPurchaseOutcomePush).not.toHaveBeenCalled();
  });
});

describe("PurchaseProcessor vendor stage budget", () => {
  it("is a small budget of its own, separate from the 150 job attempts", () => {
    expect(VENDOR_STAGE_MAX_ATTEMPTS).toBeLessThan(SETTLEMENT_MAX_ATTEMPTS);
    expect(VENDOR_STAGE_MAX_ATTEMPTS).toBe(3);
  });

  it("a vendor failure with budget left retries without FAILED or settling", async () => {
    const h = buildHarness({ order: "ambiguous" });
    const job = makeJob({ attemptsMade: 0 });
    await expect(run(h, job)).rejects.toThrow(/Failed to process order/);

    expect(job.data.vendorAttempts).toBe(1);
    expect(job.data.vendorOrderAttempted).toBe(true);
    expect(failedStatusWrites(h)).toHaveLength(0);
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
    expect(h.referenceId.markAsFailed).not.toHaveBeenCalled();
  });

  it("raising job attempts to 150 does not mean 150 vendor orders", async () => {
    const h = buildHarness({ order: "ambiguous" });
    const job = makeJob({ attemptsMade: 0, attempts: 150 });

    let runs = 0;
    let stopped: Error | undefined;
    while (runs < 150 && !stopped) {
      try {
        await run(h, job);
      } catch (e) {
        if ((e as Error).name === "UnrecoverableError") stopped = e as Error;
      }
      job.attemptsMade += 1;
      runs += 1;
    }

    expect(stopped).toBeDefined();
    expect(h.createOrder).toHaveBeenCalledTimes(VENDOR_STAGE_MAX_ATTEMPTS);
    expect(runs).toBe(VENDOR_STAGE_MAX_ATTEMPTS);
  });

  it("onOrderRetriesExhausted still fires when the vendor budget is spent, and BullMQ stops", async () => {
    const h = buildHarness({ order: "ambiguous" });
    const job = makeJob({
      attemptsMade: 40,
      attempts: 150,
      data: { vendorAttempts: VENDOR_STAGE_MAX_ATTEMPTS - 1, vendorOrderAttempted: true },
    });

    await expect(run(h, job)).rejects.toMatchObject({ name: "UnrecoverableError" });

    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.objectContaining({ orderAttempted: true }),
    );
    expect(h.referenceId.markAsFailed).toHaveBeenCalledTimes(1);
  });

  it("remembers an order attempted on an earlier run when the last run fails before the vendor", async () => {
    const h = buildHarness({ customerInfo: null });
    const job = makeJob({
      attemptsMade: 10,
      data: { vendorAttempts: VENDOR_STAGE_MAX_ATTEMPTS - 1, vendorOrderAttempted: true },
    });
    await expect(run(h, job)).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(h.createOrder).not.toHaveBeenCalled();
    // Not "refund — the vendor never heard of this": an order may exist.
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.objectContaining({ orderAttempted: true }),
    );
  });

  it("still exhausts on the job budget for a job queued with the old 3 attempts", async () => {
    const h = buildHarness({ order: "ambiguous" });
    const job = makeJob({ attemptsMade: 2, attempts: 3 });
    await expect(run(h, job)).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledTimes(1);
  });

  it("a retry after the vendor accepted does not place a second order", async () => {
    const h = buildHarness({ vendorRefId: "TRX-ALREADY" });
    const result = await run(h, makeJob({ attemptsMade: 1 }));

    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onVendorAccepted).toHaveBeenCalledWith("purchase", "pur_1");
    expect(result.success).toBe(true);
  });

  it("a definitive vendor rejection ends the job without retries", async () => {
    const h = buildHarness({ order: "definitive" });
    await expect(run(h, makeJob())).resolves.toMatchObject({ success: false });
    expect(h.referenceId.markAsFailed).toHaveBeenCalledTimes(1);
  });
});

describe("PurchaseProcessor and booking expiry", () => {
  it("completes a paid purchase whose booking expired while it waited for confirmations", async () => {
    const h = buildHarness({ bookingStatus: "EXPIRED" });
    const result = await run(h, makeJob());

    expect(result.success).toBe(true);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
    expect(h.prisma.bookingOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "EXECUTED" } }),
    );
    expect(failedStatusWrites(h)).toHaveLength(0);
  });
});

describe("PurchaseProcessor booking window (chain time)", () => {
  const afterExpiry = (ms: number) =>
    Math.floor((EXPIRES_AT.getTime() + ms) / 1000);

  it("fulfils a payment mined in time even though processing happens long after expiry", async () => {
    const h = buildHarness({ bookingStatus: "EXPIRED", recordTimestamp: IN_TIME });
    const result = await run(h, makeJob());
    expect(result.success).toBe(true);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
  });

  it("fulfils a payment mined inside the grace period", async () => {
    const h = buildHarness({
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS - 1_000),
    });
    const result = await run(h, makeJob());
    expect(result.success).toBe(true);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
  });

  it("refunds a payment mined after expiry + grace: no order, reference failed, no retry", async () => {
    const h = buildHarness({
      bookingStatus: "EXPIRED",
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS + 5_000),
    });
    const result = await run(h, makeJob());

    expect(result.success).toBe(false);
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.objectContaining({ orderAttempted: false }),
    );
    expect(h.referenceId.markAsFailed).toHaveBeenCalledWith(
      "ref_1",
      expect.objectContaining({ errorType: "booking_expired" }),
    );
    // The money arrived: the transaction row is CONFIRMED, never reverted.
    expect(h.prisma.transactionHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "CONFIRMED" } }),
    );
    expect(h.fulfilment.onPaymentUnverified).not.toHaveBeenCalled();
  });

  it("refunds a payment for a cancelled booking without ordering", async () => {
    const h = buildHarness({ bookingStatus: "CANCELLED" });
    await run(h, makeJob());
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.objectContaining({ orderAttempted: false }),
    );
  });

  it("a record with no timestamp goes to ops, never to a refund", async () => {
    const h = buildHarness({ recordTimestamp: null });
    const result = await run(h, makeJob());
    expect(result.success).toBe(false);
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
    expect(h.fulfilment.onPaymentUnverified).toHaveBeenCalledTimes(1);
  });

  it("a redelivered job after the late path orders nothing and refunds through the same idempotent call", async () => {
    const h = buildHarness({
      bookingStatus: "EXPIRED",
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS + 5_000),
    });
    await run(h, makeJob());
    await run(h, makeJob({ attemptsMade: 1 }));
    expect(h.createOrder).not.toHaveBeenCalled();
    // The fulfilment compare-and-set makes the second call a no-op; the
    // processor never reaches the vendor or the buyer push twice.
    expect(h.push.sendPurchaseOutcomePush).not.toHaveBeenCalled();
  });

  it("a purchase that already has a vendor order is past the check", async () => {
    const h = buildHarness({
      vendorRefId: "TRX-1",
      bookingStatus: "CANCELLED",
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS + 60_000),
    });
    const result = await run(h, makeJob({ attemptsMade: 1 }));
    expect(result.success).toBe(true);
    expect(h.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("a refund failure propagates so the job retries instead of losing the refund", async () => {
    const h = buildHarness({
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS + 5_000),
    });
    h.fulfilment.onOrderRetriesExhausted.mockRejectedValueOnce(new Error("db"));
    await expect(run(h, makeJob())).rejects.toThrow("db");
  });
});

describe("PurchaseProcessor points hold", () => {
  const afterExpiry = (ms: number) =>
    Math.floor((EXPIRES_AT.getTime() + ms) / 1000);

  it("consumes the hold after the window check and before the vendor order", async () => {
    const h = buildHarness({ hold: "CONSUMED" });
    const result = await run(h, makeJob());
    expect(result.success).toBe(true);
    expect(h.holds.consume).toHaveBeenCalledWith("book_1");
    expect(h.holds.consume.mock.invocationCallOrder[0]).toBeLessThan(
      h.createOrder.mock.invocationCallOrder[0],
    );
    expect(h.holds.release).not.toHaveBeenCalled();
  });

  it("a booking without points (NONE) is fulfilled as before", async () => {
    const h = buildHarness({ hold: "NONE" });
    expect((await run(h, makeJob())).success).toBe(true);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
  });

  it("a hold the sweep released before the payment arrived: no order, token part refunded, reference failed", async () => {
    const h = buildHarness({ hold: "RELEASED", bookingStatus: "EXPIRED" });
    const result = await run(h, makeJob());

    expect(result.success).toBe(false);
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.referenceId.markAsFailed).toHaveBeenCalledWith(
      "ref_1",
      expect.objectContaining({ errorType: "points_hold_released" }),
    );
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledWith(
      "purchase",
      "pur_1",
      expect.objectContaining({ orderAttempted: false }),
    );
    // The money arrived; the transaction row stays CONFIRMED.
    expect(h.prisma.transactionHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "CONFIRMED" } }),
    );
    expect(h.holds.release).not.toHaveBeenCalled();
  });

  it("a payment mined in time but processed after the sweep released the hold still ends with the buyer whole", async () => {
    // Mined 10s before expiry, registered late through the outbox, sweep ran first.
    const h = buildHarness({ hold: "RELEASED", recordTimestamp: IN_TIME });
    await run(h, makeJob());
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledTimes(1);
  });

  it("a late payment with a live hold leaves the hold to the refund, which returns both parts", async () => {
    const h = buildHarness({
      hold: "CONSUMED",
      recordTimestamp: afterExpiry(BOOKING_PAYMENT_GRACE_MS + 60_000),
    });
    await run(h, makeJob());
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledTimes(1);
    // The processor does not consume it here: FulfilmentService.refundAmount
    // does (HELD -> CONSUMED) and refunds token part + points together.
    expect(h.holds.consume).not.toHaveBeenCalled();
  });

  it("a chain verdict releases the hold", async () => {
    const h = buildHarness({
      hold: "CONSUMED",
      verify: jest.fn(async () => {
        throw new BadRequestException("Transaction 0xhash was reverted or failed");
      }),
    });
    await run(h, makeJob());
    expect(h.holds.release).toHaveBeenCalledWith("book_1", expect.stringContaining("rejected_reverted"));
    expect(h.holds.consume).not.toHaveBeenCalled();
  });

  it("a transient verification failure keeps the hold", async () => {
    const h = buildHarness({
      verify: jest.fn(async () => {
        throw new BadRequestException("Failed to verify transaction 0xhash: Timed out");
      }),
    });
    await expect(run(h, makeJob())).rejects.toThrow();
    expect(h.holds.release).not.toHaveBeenCalled();
    expect(h.holds.consume).not.toHaveBeenCalled();
  });

  it("a retried job consumes again harmlessly and orders once", async () => {
    const first = buildHarness({ hold: "CONSUMED", order: "ambiguous" });
    const job = makeJob();
    await expect(run(first, job)).rejects.toThrow();
    // Retry: the vendor accepted in the meantime.
    const second = buildHarness({ hold: "CONSUMED", vendorRefId: "TRX-1" });
    const result = await run(second, job);
    expect(result.success).toBe(true);
    expect(second.createOrder).not.toHaveBeenCalled();
    expect(second.fulfilment.onOrderRetriesExhausted).not.toHaveBeenCalled();
  });

  it("a redelivered late-path job refunds through the same idempotent call and orders nothing", async () => {
    const h = buildHarness({ hold: "RELEASED" });
    await run(h, makeJob());
    await run(h, makeJob({ attemptsMade: 1 }));
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(h.fulfilment.onOrderRetriesExhausted).toHaveBeenCalledTimes(2);
  });
});
