import { Prisma, TransactionType } from "@generated/prisma";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { loadContactLabels } from "../address-book/contact-labels";
import { CursorPaginationDto } from "../dto/common/pagination.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PushService, type SendPushResult } from "../push/push.service";
import { TokenIconService } from "../tokens/token-icon.service";
import { truncateAddress } from "../utils/address";
import { walletActivityDedupeKey } from "../wallet-activity/wallet-activity.classifier";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { SearchTransactionDto } from "./dto/search-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";

// Matches the "en-US" grouping used for points/currency everywhere else
// in the app (see mobile `utils/currencyUtils.ts` formatNumber).
const AMOUNT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 6,
});

/** A freshly created history row with its token, as `create` returns it. */
type TransactionRecord = Prisma.TransactionHistoryGetPayload<{
  include: { token: true };
}>;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    private readonly tokenIcon: TokenIconService,
  ) {}

  async create(userId: string, createTransactionDto: CreateTransactionDto) {
    // The history row and the recipient's push are one unit of work: the
    // push outbox row is written inside the same transaction, so once the
    // sender's record is committed the notification is committed with it
    // and survives anything that happens to this request afterwards
    // (process restart, Redis blip, Expo outage — see PushService).
    const { transaction, staged } = await this.prisma.$transaction(
      async (tx) => {
        const transaction = await tx.transactionHistory.create({
          data: {
            userId,
            tokenId: createTransactionDto.tokenId,
            type: createTransactionDto.type,
            status: createTransactionDto.status,
            amount: createTransactionDto.amount,
            amountInFiat: createTransactionDto.amountInFiat,
            fiatCurrency: createTransactionDto.fiatCurrency,
            txHash: createTransactionDto.txHash,
            senderAddress: createTransactionDto.fromAddress?.trim(),
            recipientAddress: createTransactionDto.toAddress?.trim(),
            merchantName: createTransactionDto.merchantName,
            paymentIntentId: createTransactionDto.paymentIntentId,
          },
          include: {
            token: true,
          },
        });
        const staged = await this.stageTransferPush(tx, transaction);
        return { transaction, staged };
      },
    );

    if (staged) {
      // Pre-build the icon PNG so the device's fetch, which happens the
      // moment the notification lands, is a cache hit rather than a cold
      // upstream fetch + rasterise on the OS's short timeout.
      this.tokenIcon.warm(transaction.token);
      // Deliberately not awaited: the row is committed, so the dispatch
      // worker — or the outbox sweeper, if this enqueue never lands —
      // delivers it regardless, and the sender's response never waits on
      // Redis.
      void this.pushService.enqueue(staged).catch((err) => {
        this.logger.warn(
          `[transactions] transfer push enqueue failed for tx ${transaction.id} (log ${staged.notificationLogId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return transaction;
  }

  /**
   * Stage the recipient's "Transfer Received" push for a freshly written
   * TRANSFER row, inside the caller's transaction. Returns null when there
   * is nothing to notify, and never throws — a push problem must not roll
   * back the sender's own history record.
   *
   * Records are written by the sender's own client right after their
   * on-chain tx is submitted, but the row already carries the recipient's
   * address — no need to wait for the recipient's own client to do
   * anything. Route by wallet address, not userId: the recipient may be an
   * entirely different backend User than the sender, or may not be one of
   * our users at all (a wallet with nothing subscribed is recorded as
   * `no_device` on the log, not an error).
   */
  private async stageTransferPush(
    tx: Prisma.TransactionClient,
    transaction: TransactionRecord,
  ): Promise<SendPushResult | null> {
    if (
      transaction.type !== TransactionType.TRANSFER ||
      !transaction.recipientAddress ||
      transaction.recipientAddress.toLowerCase() ===
        transaction.senderAddress?.toLowerCase()
    ) {
      return null;
    }

    try {
      // A client that times out and re-POSTs the same on-chain transfer
      // (or an agent executor and the send screen both recording it) must
      // not ring the recipient twice. Exact-match on the indexed txHash —
      // a resubmit sends the identical string — and scoped to recipient +
      // token so a single tx paying several recipients still notifies each.
      if (transaction.txHash) {
        const earlier = await tx.transactionHistory.findFirst({
          where: {
            txHash: transaction.txHash,
            type: TransactionType.TRANSFER,
            recipientAddress: transaction.recipientAddress,
            tokenId: transaction.tokenId,
            id: { not: transaction.id },
          },
          select: { id: true },
        });
        if (earlier) {
          this.logger.log(
            `[transactions] transfer ${transaction.id} duplicates ${earlier.id} (txHash ${transaction.txHash}); recipient already notified`,
          );
          return null;
        }
      }

      const humanAmount = new Prisma.Decimal(transaction.amount.toString())
        .div(new Prisma.Decimal(10).pow(transaction.token.decimals))
        .toNumber();
      const amountFormatted = AMOUNT_NUMBER_FORMAT.format(humanAmount);
      // The recipient's own name for the sender, if they saved one ("from
      // Alice"), read outside `tx` — see loadContactLabels.
      const contactName = (
        await loadContactLabels(this.prisma, transaction.recipientAddress)
      )(transaction.senderAddress);
      const senderLabel = transaction.senderAddress
        ? (contactName ?? truncateAddress(transaction.senderAddress))
        : "another wallet";
      const recipientShort = truncateAddress(transaction.recipientAddress);

      return await this.pushService.stageToWallet(
        {
          walletAddress: transaction.recipientAddress,
          title: "Transfer Received",
          body: `You received ${amountFormatted} ${transaction.token.symbol} from ${senderLabel} to ${recipientShort}.`,
          // Our own PNG endpoint, not the raw logoUrl: Android decodes the
          // push image with BitmapFactory and silently drops SVGs and
          // hot-link-blocked hosts — see TokenIconService.
          imageUrl: this.tokenIcon.pushImageUrl(transaction.token),
          data: {
            type: "transfer",
            transactionId: transaction.id,
            senderAddress: transaction.senderAddress,
            recipientAddress: transaction.recipientAddress,
            tokenSymbol: transaction.token.symbol,
          },
          channelId: "transfers",
          source: "transfer",
          // Same key the Zerion webhook uses for this (tx, recipient): the
          // recipient hears about the transfer once, whichever producer
          // gets there first.
          dedupeKey: transaction.txHash
            ? walletActivityDedupeKey(
                transaction.txHash,
                transaction.recipientAddress,
              )
            : undefined,
        },
        tx,
      );
    } catch (err) {
      this.logger.warn(
        `[transactions] transfer push staging failed for tx ${transaction.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async findAll(paginationDto: CursorPaginationDto) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    // For hypertable with composite PK, use createdAt-based cursor pagination
    let cursorDate: Date | undefined;
    if (cursor && !useSkip) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      cursorDate = cursorTx?.createdAt;
    }

    const where: Prisma.TransactionHistoryWhereInput = cursorDate
      ? { createdAt: { lt: cursorDate } }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.transactionHistory.findMany({
        take,
        ...(useSkip ? { skip } : {}),
        where,
        include: {
          token: true,
          user: {
            select: {
              id: true,
              walletAddress: true,
              username: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.transactionHistory.count(),
    ]);

    return { items, total };
  }

  async findOne(id: string) {
    // Use findFirst for hypertable with composite PK (id alone is indexed but not unique constraint)
    const transaction = await this.prisma.transactionHistory.findFirst({
      where: { id },
      include: {
        token: {
          include: {
            blockchain: true,
          },
        },
        user: {
          select: {
            id: true,
            walletAddress: true,
            username: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }

    return transaction;
  }

  async findPaymentDetail(id: string) {
    const transaction = await this.prisma.transactionHistory.findFirst({
      where: { id },
      include: {
        token: {
          include: {
            blockchain: true,
          },
        },
      },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }

    if (transaction.type !== "PAYMENT") {
      throw new NotFoundException(
        `Transaction ${id} is not a merchant payment`,
      );
    }

    let intentDetail: {
      fiatAmountMinor: number;
      fiatCurrency: string;
      merchant: { displayName: string; country: string } | null;
      createdAt: Date;
      expiresAt: Date;
    } | null = null;

    if (transaction.paymentIntentId) {
      const intent = await this.prisma.paymentIntent.findUnique({
        where: { id: transaction.paymentIntentId },
        select: {
          fiatAmountMinor: true,
          fiatCurrency: true,
          createdAt: true,
          expiresAt: true,
          merchant: {
            select: {
              displayName: true,
              country: true,
            },
          },
        },
      });
      intentDetail = intent;
    }

    return {
      ...transaction,
      intent: intentDetail,
    };
  }

  async updateStatus(id: string, updateTransactionDto: UpdateTransactionDto) {
    const transaction = await this.findOne(id);

    return await this.prisma.transactionHistory.update({
      where: {
        id_createdAt: {
          id: transaction.id,
          createdAt: transaction.createdAt,
        },
      },
      data: updateTransactionDto,
      include: {
        token: true,
      },
    });
  }

  async findByUser(userId: string, paginationDto: CursorPaginationDto = {}) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const { cursor, take = 50, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    let cursorDate: Date | undefined;
    if (cursor && !useSkip) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      cursorDate = cursorTx?.createdAt;
    }

    const where: Prisma.TransactionHistoryWhereInput = {
      userId,
      ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.transactionHistory.findMany({
        where,
        take,
        ...(useSkip ? { skip } : {}),
        include: {
          token: true,
          user: {
            select: {
              id: true,
              walletAddress: true,
              username: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.transactionHistory.count({ where: { userId } }),
    ]);

    return { items, total };
  }

  async findByBlockchain(
    blockchainId: string,
    paginationDto: CursorPaginationDto = {},
  ) {
    const blockchain = await this.prisma.blockchain.findUnique({
      where: { id: blockchainId },
    });

    if (!blockchain) {
      throw new NotFoundException(
        `Blockchain with ID ${blockchainId} not found`,
      );
    }

    const { cursor, take = 50, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    let cursorDate: Date | undefined;
    if (cursor && !useSkip) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      cursorDate = cursorTx?.createdAt;
    }

    const baseWhere: Prisma.TransactionHistoryWhereInput = {
      token: { blockchainId },
    };

    const where: Prisma.TransactionHistoryWhereInput = {
      ...baseWhere,
      ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.transactionHistory.findMany({
        where,
        take,
        ...(useSkip ? { skip } : {}),
        include: {
          token: true,
          user: {
            select: {
              id: true,
              walletAddress: true,
              username: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.transactionHistory.count({ where: baseWhere }),
    ]);

    return { items, total };
  }

  async findByToken(tokenId: string, paginationDto: CursorPaginationDto = {}) {
    const token = await this.prisma.token.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      throw new NotFoundException(`Token with ID ${tokenId} not found`);
    }

    const { cursor, take = 50, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;

    let cursorDate: Date | undefined;
    if (cursor && !useSkip) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      cursorDate = cursorTx?.createdAt;
    }

    const baseWhere: Prisma.TransactionHistoryWhereInput = { tokenId };
    const where: Prisma.TransactionHistoryWhereInput = {
      ...baseWhere,
      ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.transactionHistory.findMany({
        where,
        take,
        ...(useSkip ? { skip } : {}),
        include: {
          token: true,
          user: {
            select: {
              id: true,
              walletAddress: true,
              username: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.transactionHistory.count({ where: baseWhere }),
    ]);

    return { items, total };
  }

  async findUserTransactionHistory(
    userId: string,
    type?: TransactionType,
    paginationDto?: CursorPaginationDto,
  ) {
    const { cursor, take = 10 } = paginationDto || {};

    const where: Prisma.TransactionHistoryWhereInput = {
      userId,
    };

    if (type) {
      where.type = type;
    }

    // For hypertable with composite PK, use createdAt-based cursor pagination
    if (cursor) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      if (cursorTx) {
        where.createdAt = { lt: cursorTx.createdAt };
      }
    }

    const transactions = await this.prisma.transactionHistory.findMany({
      take,
      where,
      include: {
        token: {
          select: {
            blockchain: {
              select: {
                name: true,
                blockExplorer: true,
                tokens: {
                  where: {
                    isNativeCurrency: true,
                    isActive: true,
                  },
                },
              },
            },
            contractAddress: true,
            name: true,
            symbol: true,
            decimals: true,
            logoUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Purchase has no Prisma relation to TransactionHistory (hypertable).
    // Post-fetch associated purchases and attach them manually.
    const txIds = transactions.map((t) => t.id);
    const purchases = await this.prisma.purchase.findMany({
      where: { transactionId: { in: txIds } },
      include: {
        productVariant: {
          select: {
            name: true,
            product: {
              select: {
                id: true,
                imageUrl: true,
              },
            },
          },
        },
        bookingOrder: { select: { pointsApplied: true } },
      },
    });
    const purchaseByTxId = new Map(
      purchases.map((p) => [p.transactionId, withPointsApplied(p)]),
    );

    return transactions.map((t) => ({
      ...t,
      purchase: purchaseByTxId.get(t.id) ?? null,
    }));
  }

  async search(
    searchParams: SearchTransactionDto,
    paginationDto: CursorPaginationDto,
  ) {
    const { cursor, take = 10, skip } = paginationDto;
    const useSkip = typeof skip === "number" && skip > 0;
    const {
      type,
      status,
      userId,
      tokenId,
      senderAddress,
      recipientAddress,
      txHash,
      minAmount,
      maxAmount,
      startDate,
      endDate,
    } = searchParams;

    const where: Prisma.TransactionHistoryWhereInput = {};

    if (type) where.type = type;
    if (status) where.status = status;
    if (userId) where.userId = userId;
    if (tokenId) where.tokenId = tokenId;

    if (senderAddress) {
      where.senderAddress = {
        equals: senderAddress,
        mode: "insensitive",
      };
    }
    if (recipientAddress) {
      where.recipientAddress = {
        equals: recipientAddress,
        mode: "insensitive",
      };
    }

    if (txHash) {
      where.txHash = {
        equals: txHash,
        mode: "insensitive",
      };
    }

    if (minAmount || maxAmount) {
      where.amount = {};
      if (minAmount) where.amount.gte = minAmount;
      if (maxAmount) where.amount.lte = maxAmount;
    }

    if (startDate || endDate) {
      where.createdAt = where.createdAt || {};
      if (startDate)
        (where.createdAt as Prisma.DateTimeFilter).gte = new Date(startDate);
      if (endDate)
        (where.createdAt as Prisma.DateTimeFilter).lte = new Date(endDate);
    }

    const baseWhere = { ...where } as Prisma.TransactionHistoryWhereInput;

    // For hypertable with composite PK, use createdAt-based cursor pagination
    if (cursor && !useSkip) {
      const cursorTx = await this.prisma.transactionHistory.findFirst({
        where: { id: cursor },
        select: { createdAt: true },
      });
      if (cursorTx) {
        where.createdAt = where.createdAt || {};
        (where.createdAt as Prisma.DateTimeFilter).lt = cursorTx.createdAt;
      }
    }

    const [transactions, total] = await Promise.all([
      this.prisma.transactionHistory.findMany({
        take,
        ...(useSkip ? { skip } : {}),
        where,
        include: {
          token: {
            select: {
              blockchain: {
                select: {
                  name: true,
                  blockExplorer: true,
                },
              },
              contractAddress: true,
              name: true,
              symbol: true,
              decimals: true,
              logoUrl: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.transactionHistory.count({ where: baseWhere }),
    ]);

    // Purchase has no Prisma relation to TransactionHistory (hypertable).
    // Post-fetch associated purchases and attach them manually.
    const txIds = transactions.map((t) => t.id);
    const purchases = await this.prisma.purchase.findMany({
      where: { transactionId: { in: txIds } },
      include: {
        productVariant: {
          select: {
            name: true,
            product: {
              select: {
                id: true,
                imageUrl: true,
              },
            },
          },
        },
        bookingOrder: { select: { pointsApplied: true } },
      },
    });
    const purchaseByTxId = new Map(
      purchases.map((p) => [p.transactionId, withPointsApplied(p)]),
    );

    const items = transactions.map((t) => ({
      ...t,
      purchase: purchaseByTxId.get(t.id) ?? null,
    }));

    return { items, total };
  }
}

/**
 * Flattens `bookingOrder.pointsApplied` onto the purchase as a string, so the
 * app can show "1.85 USDC + 30,000 points" without the booking row.
 */
function withPointsApplied<
  T extends { bookingOrder: { pointsApplied: bigint } | null },
>(p: T) {
  const { bookingOrder, ...rest } = p;
  return { ...rest, pointsApplied: (bookingOrder?.pointsApplied ?? 0n).toString() };
}
