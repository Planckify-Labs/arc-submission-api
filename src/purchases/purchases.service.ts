import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { mapVendorErrorToException } from "./exceptions/vendor-api.exceptions";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePurchaseDto, UpdatePurchaseDto } from "./dto/purchase.dto";
import { SearchPurchaseDto } from "./dto/search-purchase.dto";
import { addressesEqual } from "../auth/address-compare";
import { canonicalizeWalletAddress } from "../utils/address";
import { Prisma, PurchaseStatus, ReferenceIdStatus } from "@generated/prisma";
import { CursorPaginationDto } from "../dto/common/pagination.dto";
import { ReferenceIdService } from "../reference-id/reference-id.service";
import { QueueService } from "../queue/queue.service";
import { BlockchainCacheService } from "../valkey/services/blockchain-cache.service";
import { SmartContractCacheService } from "../valkey/services/smart-contract-cache.service";
import { TokenCacheService } from "../valkey/services/token-cache.service";
import { FulfilmentService } from "../fulfilment/fulfilment.service";
import {
  fulfilmentView,
  isWorthChecking,
  legacyVoucherCode,
} from "../fulfilment/fulfilment-view";
import { UserRole } from "@generated/prisma";

/** The caller of a read, for ownership checks. Admins see everything. */
export interface PurchaseViewer {
  id: string;
  walletAddress: string | null;
  role: UserRole;
}

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly referenceIdService: ReferenceIdService,
    private readonly queueService: QueueService,
    private readonly blockchainCache: BlockchainCacheService,
    private readonly contractCache: SmartContractCacheService,
    private readonly tokenCache: TokenCacheService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  async create(createPurchaseDto: CreatePurchaseDto) {
    const {
      refId,
      bookingId,
      walletAddress,
      networkId,
      contractAddress,
      transactionHash,
    } = createPurchaseDto;

    const existingRefId =
      await this.referenceIdService.getReferenceIdStatus(refId);

    if (existingRefId) {
      if (
        existingRefId.status === ReferenceIdStatus.COMPLETED &&
        existingRefId.metadata &&
        typeof existingRefId.metadata === "object"
      ) {
        const metadata = existingRefId.metadata as Record<string, unknown>;

        if (metadata.purchaseId && typeof metadata.purchaseId === "string") {
          const existingPurchase = await this.prisma.purchase.findUnique({
            where: { id: metadata.purchaseId },
            include: {
              productVariant: true,
            },
          });

          if (
            existingPurchase &&
            metadata.bookingId &&
            typeof metadata.bookingId === "string"
          ) {
            const productVariant = existingPurchase.productVariant as Record<
              string,
              unknown
            >;
            const { product, ...productVariantWithoutProduct } = productVariant;

            return {
              ...existingPurchase,
              bookingId: metadata.bookingId,
              productVariant: productVariantWithoutProduct,
            };
          }
        }
      }

      if (existingRefId.status === ReferenceIdStatus.PROCESSING) {
        return {
          refId,
          status: PurchaseStatus.PENDING,
          message: "Purchase is being processed in the background",
          processingStatus: "in_progress",
        };
      }

      console.log(
        `Reference ID '${refId}' is already being processed. Status: ${existingRefId.status}`,
      );
    }

    const bookingForMetadata = await this.prisma.bookingOrder.findUnique({
      where: { id: bookingId },
      include: {
        productVariant: {
          include: {
            product: true,
          },
        },
        productPrice: {
          include: {
            vendor: true,
          },
        },
      },
    });

    if (!bookingForMetadata) {
      throw new NotFoundException(`Booking with ID ${bookingId} not found`);
    }

    if (!addressesEqual(bookingForMetadata.walletAddress, walletAddress)) {
      throw new BadRequestException(
        `Wallet address mismatch: booking belongs to ${bookingForMetadata.walletAddress}`,
      );
    }

    const payment = bookingForMetadata.payment as {
      tokenAddress: string;
      blockchainNetworkId: string;
      amount: string;
    };

    if (payment.blockchainNetworkId !== networkId) {
      throw new BadRequestException(
        `Network ID mismatch: booking uses network ${payment.blockchainNetworkId}, but ${networkId} was provided`,
      );
    }

    // Use cache for blockchain lookup (hot path optimization)
    const blockchain = await this.blockchainCache.getById(networkId, () =>
      this.prisma.blockchain.findUnique({
        where: { id: networkId },
      }),
    );

    if (!blockchain) {
      throw new NotFoundException(`Network with ID ${networkId} not found`);
    }

    if (!blockchain.isActive) {
      throw new BadRequestException(`Network ${blockchain.name} is not active`);
    }

    // Use cache for smart contract lookup (hot path optimization)
    const smartContract = await this.contractCache.getByBlockchainAndAddress(
      networkId,
      contractAddress,
      () =>
        this.prisma.smartContract.findFirst({
          where: {
            blockchainId: networkId,
            address: {
              equals: contractAddress,
              mode: "insensitive",
            },
          },
        }),
    );

    if (!smartContract) {
      throw new BadRequestException(
        `Smart contract with address ${contractAddress} not found on network ${blockchain.name}`,
      );
    }

    if (!smartContract.isActive) {
      throw new BadRequestException(
        `Smart contract ${smartContract.name} is not active on network ${blockchain.name}`,
      );
    }

    // Purchase flow is EVM-only (smart-contract transactions via viem).
    // `normalizedWalletAddress` stays lowercase for the transaction's
    // `senderAddress` (tx search filters on it case-sensitively); the User
    // row is deduped by the canonical (checksummed) form instead.
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const canonicalWalletAddress = canonicalizeWalletAddress(
      walletAddress,
      "eip155",
    );

    let user = await this.prisma.user.findUnique({
      where: { walletAddress: canonicalWalletAddress },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          walletAddress: canonicalWalletAddress,
          authProvider: "WALLET",
        },
      });
    }

    // Use cache for token lookup (hot path optimization)
    const token = await this.tokenCache.getByBlockchainAndAddress(
      networkId,
      payment.tokenAddress,
      () =>
        this.prisma.token.findUnique({
          where: {
            blockchainId_contractAddress: {
              blockchainId: networkId,
              contractAddress: payment.tokenAddress,
            },
          },
        }),
    );

    if (!token) {
      throw new BadRequestException(
        `Token with address ${payment.tokenAddress} not found on network`,
      );
    }

    // Calculate amountInFiat based on exchange rate and product price
    const exchangeRateObj = bookingForMetadata.exchangeRate as {
      rate: number;
      toCurrency: string;
      fromCurrency: string;
    } | null;
    const rate = exchangeRateObj?.rate || 0;
    const sellPrice =
      bookingForMetadata.productPrice?.sellPrice?.toString() || "0";
    const fullFiat =
      rate &&
      sellPrice &&
      exchangeRateObj?.toCurrency == bookingForMetadata.productPrice?.currency
        ? sellPrice
        : (Number(sellPrice) * rate).toString() || "0";
    // The part paid in tokens. Points applied (1 pt = Rp 1) are refunded
    // separately from the booking's hold, so this must not include them.
    const pointsApplied = bookingForMetadata.pointsApplied ?? 0n;
    const amountInFiat =
      pointsApplied > 0n
        ? new Prisma.Decimal(fullFiat).sub(pointsApplied.toString()).toString()
        : fullFiat;

    const placeholderTransaction = await this.prisma.transactionHistory.create({
      data: {
        user: { connect: { id: user.id } },
        token: { connect: { id: token.id } },
        amount: payment.amount,
        amountInFiat: amountInFiat,
        fiatCurrency: exchangeRateObj?.toCurrency || "IDR",
        type: "PAYMENT",
        status: "PENDING",
        senderAddress: normalizedWalletAddress,
        recipientAddress: contractAddress.toLowerCase(),
        txHash: transactionHash,
      },
    });

    const purchase = await this.prisma.purchase.create({
      data: {
        transactionId: placeholderTransaction.id,
        transactionCreatedAt: placeholderTransaction.createdAt,
        productVariantId: bookingForMetadata.productVariantId,
        bookingOrderId: bookingId,
        status: PurchaseStatus.PROCESSING,
        refId,
      },
    });

    try {
      await this.referenceIdService.markAsProcessing(refId, {
        requestType: "PURCHASE",
        walletAddress,
        bookingId,
        purchaseId: purchase.id,
        stage: "queued_for_processing",
        message: "Purchase created and queued for background processing",
      });

      const jobId = await this.queueService.addPurchaseJob({
        refId,
        bookingId,
        walletAddress,
        networkId,
        contractAddress,
        transactionHash,
        userId: user.id,
        tokenId: token.id,
        purchaseId: purchase.id,
      });

      console.log(`Purchase job queued with ID: ${jobId} for refId: ${refId}`);

      return {
        id: purchase.id,
        refId,
        status: PurchaseStatus.PROCESSING,
        message: "Purchase created and is being processed in the background",
        processingStatus: "queued",
        jobId,
        bookingId,
        estimatedProcessingTime: "2-5 minutes",
        createdAt: purchase.createdAt,
      };
    } catch (error) {
      await this.prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: PurchaseStatus.FAILED },
      });

      await this.referenceIdService.markAsFailed(refId, {
        requestType: "PURCHASE",
        walletAddress,
        bookingId,
        purchaseId: purchase.id,
        error: error.message,
        errorType: "queue_error",
      });

      throw new BadRequestException(
        `Failed to queue purchase for processing: ${error.message}`,
      );
    }
  }

  async findAll(paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        ...findArgs,
        include: {
          productVariant: {
            include: {
              product: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.purchase.count(),
    ]);

    return { items, total };
  }

  async findOne(
    id: string,
    options?: { vendorResponse?: boolean; viewer?: PurchaseViewer },
  ) {
    const include = {
      productVariant: { include: { product: true } },
      bookingOrder: {
        select: {
          id: true,
          createdAt: true,
          customerInfo: true,
          walletAddress: true,
          pointsApplied: true,
        },
      },
      refund: { select: { status: true, points: true } },
    } as const;

    let purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include,
    });

    if (!purchase) {
      throw new NotFoundException(`Purchase with ID ${id} not found`);
    }

    // TransactionHistory is a TimescaleDB hypertable — no Prisma relation exists.
    // Fetch the linked transaction manually using the stored FK columns.
    const transaction = await this.prisma.transactionHistory.findFirst({
      where: {
        id: purchase.transactionId,
        createdAt: purchase.transactionCreatedAt,
      },
      include: {
        token: {
          include: {
            blockchain: true,
          },
        },
      },
    });

    // A voucher code is the product. Only its buyer (or ops) may read it;
    // a stranger with a guessed id gets the same 404 as a missing row.
    const viewer = options?.viewer;
    if (viewer && !this.isAdmin(viewer)) {
      const ownsWallet =
        !!viewer.walletAddress &&
        addressesEqual(
          purchase.bookingOrder.walletAddress,
          viewer.walletAddress,
        );
      const ownsTx = transaction?.userId === viewer.id;
      if (!ownsWallet && !ownsTx) {
        throw new NotFoundException(`Purchase with ID ${id} not found`);
      }
    }

    // The user is looking and the poller hasn't asked recently: ask now,
    // through the same state machine, so what they see is what the push
    // will say.
    if (isWorthChecking(purchase)) {
      try {
        await this.fulfilment.check("purchase", id, { reschedule: false });
        purchase =
          (await this.prisma.purchase.findUnique({ where: { id }, include })) ??
          purchase;
      } catch (error) {
        this.logger.warn(
          `Live fulfilment check failed for purchase ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const fulfilment = fulfilmentView(purchase);
    const voucherCode = legacyVoucherCode(
      fulfilment.delivery,
      purchase.deliveryRaw,
    );
    const { bookingOrder, refund: _refund, ...rest } = purchase;
    const booking = {
      id: bookingOrder.id,
      createdAt: bookingOrder.createdAt,
      customerInfo: bookingOrder.customerInfo,
    };
    // Points that paid part of the price; the token part is `transaction.amount`.
    const pointsApplied = (bookingOrder.pointsApplied ?? 0n).toString();

    if (options?.vendorResponse) {
      return {
        ...rest,
        bookingOrder: booking,
        pointsApplied,
        transaction,
        vendorName: this.extractVendorName(purchase.vendorStatusResponse),
        voucherCode,
        fulfilment,
        lastChecked: purchase.vendorLastCheckedAt ?? purchase.updatedAt,
        vendorStatusResponse: this.extractRawVendorResponse(
          purchase.vendorStatusResponse,
        ),
      };
    }
    return {
      id: purchase.id,
      status: purchase.status,
      transactionId: purchase.transactionId,
      productVariantId: purchase.productVariantId,
      refId: purchase.refId,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
      transaction,
      productVariant: purchase.productVariant,
      voucherCode,
      fulfilment,
      booking,
      pointsApplied,
    };
  }

  private isAdmin(viewer: PurchaseViewer): boolean {
    return (
      viewer.role === UserRole.ADMIN || viewer.role === UserRole.SUPER_ADMIN
    );
  }

  async updateStatus(id: string, updatePurchaseDto: UpdatePurchaseDto) {
    await this.findOne(id);

    const updateData: Prisma.PurchaseUpdateInput = {
      status: updatePurchaseDto.status,
      vendorRefId: updatePurchaseDto.vendorRefId,
      ...(updatePurchaseDto.vendorResponse && {
        vendorResponse:
          updatePurchaseDto.vendorResponse as Prisma.InputJsonValue,
      }),
    };

    return await this.prisma.purchase.update({
      where: { id },
      data: updateData,
      include: {
        productVariant: {
          include: {
            product: true,
          },
        },
      },
    });
  }

  async search(
    searchParams: SearchPurchaseDto,
    paginationDto: CursorPaginationDto,
  ) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;
    const {
      userId,
      transactionId,
      productId,
      vendorId,
      tokenId,
      blockchainId,
      status,
    } = searchParams;

    // Purchase has no Prisma relation to TransactionHistory (hypertable).
    // Pre-fetch matching transaction IDs to filter by transaction properties.
    let filteredTransactionIds: string[] | undefined;
    if (userId || tokenId || blockchainId) {
      const txWhere: Prisma.TransactionHistoryWhereInput = {};
      if (userId) txWhere.userId = userId;
      if (tokenId) txWhere.tokenId = tokenId;
      if (blockchainId) txWhere.token = { blockchainId };

      const matchingTxs = await this.prisma.transactionHistory.findMany({
        where: txWhere,
        select: { id: true },
      });
      filteredTransactionIds = matchingTxs.map((t) => t.id);

      if (filteredTransactionIds.length === 0) {
        return { items: [], total: 0 };
      }
    }

    const where: Prisma.PurchaseWhereInput = {
      ...(transactionId && { transactionId }),
      ...(filteredTransactionIds && {
        transactionId: { in: filteredTransactionIds },
      }),
      ...(status && { status }),
      ...(productId && {
        productVariant: {
          product: {
            id: productId,
          },
        },
      }),
      ...(vendorId && {
        productVariant: {
          ProductPrice: {
            some: {
              vendor: {
                id: vendorId,
              },
            },
          },
        },
      }),
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        ...findArgs,
        where,
        include: {
          productVariant: {
            include: {
              product: true,
              ProductPrice: {
                include: {
                  vendor: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return { items, total };
  }

  async findByUser(userId: string, paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    // No Prisma relation from Purchase → TransactionHistory (hypertable).
    // Pre-fetch transaction IDs owned by this user.
    const userTxs = await this.prisma.transactionHistory.findMany({
      where: { userId },
      select: { id: true },
    });
    const transactionIds = userTxs.map((t) => t.id);

    if (transactionIds.length === 0) return { items: [], total: 0 };

    const where: Prisma.PurchaseWhereInput = {
      transactionId: { in: transactionIds },
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        ...findArgs,
        where,
        include: {
          productVariant: {
            include: {
              product: true,
              ProductPrice: {
                include: {
                  vendor: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return { items, total };
  }

  async findByToken(tokenId: string, paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    const token = await this.prisma.token.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      throw new NotFoundException(`Token with ID ${tokenId} not found`);
    }

    // No Prisma relation from Purchase → TransactionHistory (hypertable).
    // Pre-fetch transaction IDs for this token.
    const tokenTxs = await this.prisma.transactionHistory.findMany({
      where: { tokenId },
      select: { id: true },
    });
    const transactionIds = tokenTxs.map((t) => t.id);

    if (transactionIds.length === 0) return { items: [], total: 0 };

    const where: Prisma.PurchaseWhereInput = {
      transactionId: { in: transactionIds },
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        ...findArgs,
        where,
        include: {
          productVariant: {
            include: {
              product: true,
              ProductPrice: {
                include: {
                  vendor: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return { items, total };
  }

  async findByBlockchain(
    blockchainId: string,
    paginationDto: CursorPaginationDto,
  ) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    // Use cache for blockchain lookup
    const blockchain = await this.blockchainCache.getById(blockchainId, () =>
      this.prisma.blockchain.findUnique({
        where: { id: blockchainId },
      }),
    );

    if (!blockchain) {
      throw new NotFoundException(
        `Blockchain with ID ${blockchainId} not found`,
      );
    }

    // No Prisma relation from Purchase → TransactionHistory (hypertable).
    // Pre-fetch transaction IDs for this blockchain.
    const blockchainTxs = await this.prisma.transactionHistory.findMany({
      where: { token: { blockchainId } },
      select: { id: true },
    });
    const transactionIds = blockchainTxs.map((t) => t.id);

    if (transactionIds.length === 0) return { items: [], total: 0 };

    const where: Prisma.PurchaseWhereInput = {
      transactionId: { in: transactionIds },
    };

    const findArgs = {
      take,
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        ...findArgs,
        where,
        include: {
          productVariant: {
            include: {
              product: true,
              ProductPrice: {
                include: {
                  vendor: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return { items, total };
  }

  private extractVendorName(vendorStatusResponse: unknown): string | null {
    try {
      const response = vendorStatusResponse as {
        vendorName?: string;
      };
      return response?.vendorName || null;
    } catch (error) {
      this.logger.debug("Failed to extract vendor name", {
        error: (error as Error).message,
      });
      return null;
    }
  }

  private extractRawVendorResponse(vendorStatusResponse: unknown): unknown {
    try {
      const response = vendorStatusResponse as {
        vendorStatusResponse?: unknown;
      };
      return response?.vendorStatusResponse || null;
    } catch (error) {
      this.logger.debug("Failed to extract raw vendor response", {
        error: (error as Error).message,
      });
      return null;
    }
  }

  async getReferenceIdWithPurchase(refId: string) {
    const referenceId =
      await this.referenceIdService.getReferenceIdStatus(refId);

    if (
      !referenceId ||
      !referenceId.metadata ||
      typeof referenceId.metadata !== "object"
    ) {
      return null;
    }

    const metadata = referenceId.metadata as Record<string, unknown>;

    if (!metadata.purchaseId || typeof metadata.purchaseId !== "string") {
      return null;
    }

    const purchase = await this.prisma.purchase.findUnique({
      where: { id: metadata.purchaseId },
      include: {
        productVariant: true,
      },
    });

    if (
      !purchase ||
      !metadata.bookingId ||
      typeof metadata.bookingId !== "string"
    ) {
      return null;
    }

    return {
      purchase,
      bookingId: metadata.bookingId,
      status: referenceId.status,
    };
  }
}
