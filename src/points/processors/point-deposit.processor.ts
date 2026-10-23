import { PointTransactionStatus, Prisma } from "@generated/prisma";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job } from "bullmq";
import { BlockchainVerificationService } from "../../blockchain-verification/blockchain-verification.service";
import {
  SETTLEMENT_MAX_ATTEMPTS,
  classifySettlementError,
  resolveMinConfirmations,
  settlementBackoffStrategy,
} from "../../blockchain-verification/settlement-policy";
import { PrismaService } from "../../prisma/prisma.service";
import { PushService } from "../../push/push.service";
import { truncateAddress } from "../../utils/address";
import { PointsCacheService } from "../../valkey/services/points-cache.service";
import { lockPointDeposit, samePointDeposit } from "../point-deposit-identity";

interface PointDepositJobData {
  pointTransactionId: string;
  pointTransactionCreatedAt: Date;
}

// Matches the "en-US" grouping used for points/currency everywhere else
// in the app (see mobile `utils/currencyUtils.ts` formatNumber) — accepts
// bigint directly, no need to round-trip through Number.
const POINTS_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Outcome rules mirror `OnchainSettlementProcessor` (see
 * `settlement-policy.ts`): the user is told "didn't go through" only when
 * the chain reverted the tx (nothing moved); a mined-but-mismatched
 * deposit or one still unconfirmed after the whole retry budget is
 * handed to ops as needs-review with a "we're checking" note; and a
 * failure on OUR side (RPC down, chain client missing, receipt not yet
 * available) is retried on the long schedule in silence — the user
 * already paid on-chain, so there is nothing to tell them yet.
 */
@Processor("point-deposit", {
  concurrency: 5,
  settings: { backoffStrategy: settlementBackoffStrategy },
})
export class PointDepositProcessor extends WorkerHost {
  private readonly logger = new Logger(PointDepositProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchainVerification: BlockchainVerificationService,
    private readonly pointsCache: PointsCacheService,
    private readonly pushService: PushService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PointDepositJobData>): Promise<void> {
    const { pointTransactionId, pointTransactionCreatedAt } = job.data;
    const txKey = {
      id: pointTransactionId,
      createdAt: new Date(pointTransactionCreatedAt),
    };

    this.logger.log(
      `Processing point deposit job ${job.id} for tx ${pointTransactionId}`,
    );

    // 2. Fetch PointTransaction with relations
    const pointTx = await this.prisma.pointTransaction.findUnique({
      where: { id_createdAt: txKey },
      include: {
        user: { select: { id: true, walletAddress: true } },
        token: true,
        blockchain: true,
      },
    });

    if (!pointTx) {
      this.logger.warn(
        `PointTransaction ${pointTransactionId} not found — skipping`,
      );
      return;
    }

    if (pointTx.status !== PointTransactionStatus.PENDING) {
      this.logger.warn(
        `PointTransaction (tx ${pointTx.txHash}) is ${pointTx.status} — skipping`,
      );
      return;
    }

    try {
      // 3 & 4. Verify tx receipt + read contract
      const token = pointTx.token!;
      const blockchain = pointTx.blockchain!;
      const user = pointTx.user;

      if (!user.walletAddress) {
        throw new Error("User has no wallet address");
      }
      if (!token.contractAddress) {
        throw new Error(`Token ${token.symbol} has no contract address`);
      }
      // Only EVM chains need a real chainId — Solana/Stellar dispatch off
      // blockchainId instead (see BlockchainVerificationService.verifyPointDeposit).
      if (blockchain.type === "EVM" && blockchain.chainId == null) {
        throw new Error(`EVM blockchain ${blockchain.name} is missing chainId`);
      }

      await this.blockchainVerification.verifyPointDeposit({
        txHash: pointTx.txHash!,
        chainId: blockchain.chainId ?? 0,
        contractAddress: pointTx.contractAddress ?? "",
        refId: pointTx.refId!,
        // Prefer the deposit's own recorded payer (validated against the
        // user's linked addresses at submission time) so non-EVM chains
        // verify the real on-chain payer; fall back to the user's primary
        // address for legacy rows created before this column existed.
        expectedWalletAddress: pointTx.walletAddress ?? user.walletAddress,
        expectedTokenAddress: token.contractAddress,
        expectedAmount: BigInt(pointTx.tokenAmount!.toFixed(0)),
        // Per-chain depth (Monad = 1), env default otherwise — the same
        // resolution every other verifier uses.
        minConfirmations: resolveMinConfirmations(blockchain, this.config),
        blockchainId: blockchain.id,
      });

      // 5. Mark CONFIRMED
      await this.prisma.pointTransaction.update({
        where: { id_createdAt: txKey },
        data: { status: PointTransactionStatus.CONFIRMED },
      });

      // 6. Calculate final points
      // pointRate was stored at submission time (pointsPerToken)
      const pointRate = pointTx.pointRate ?? new Prisma.Decimal(0);
      const humanAmount = new Prisma.Decimal(
        pointTx.tokenAmount!.toString(),
      ).div(new Prisma.Decimal(10).pow(token.decimals));
      // Round rather than floor: the deposited token amount is quantized to
      // the token's decimals, so it will essentially never multiply back to
      // an exact integer point count. Flooring always rounds that quantization
      // noise against the user; round-half-up is unbiased and matches what
      // the depositor actually requested.
      const points = BigInt(humanAmount.mul(pointRate).round().toFixed(0));

      // 7. Credit points atomically, at most once per on-chain deposit.
      //    Intake keeps one live row per (user, deposit) and only accepts the
      //    session wallet as payer, so a second credited row should be
      //    impossible — but rows accepted before that (via self-asserted
      //    wallet links) could name another user's payment. The chain moved
      //    the money once; it is credited once.
      const deposit = {
        blockchainId: blockchain.id,
        contractAddress: pointTx.contractAddress ?? "",
        refId: pointTx.refId!,
      };
      const finalBalance = await this.prisma.$transaction(async (tx) => {
        await lockPointDeposit(tx, deposit);
        const alreadyCredited = await tx.pointTransaction.findFirst({
          where: {
            ...samePointDeposit(deposit),
            status: PointTransactionStatus.COMPLETED,
            NOT: { id: pointTransactionId },
          },
          select: { id: true },
        });
        if (alreadyCredited) {
          await tx.pointTransaction.update({
            where: { id_createdAt: txKey },
            data: {
              status: PointTransactionStatus.FAILED,
              metadata: {
                error: "on-chain deposit already credited",
                duplicateOf: alreadyCredited.id,
                failedAt: new Date().toISOString(),
              },
            },
          });
          return null;
        }

        const balance = await tx.pointBalance.findUnique({
          where: { userId: pointTx.userId },
        });

        const currentBalance = balance?.balance ?? BigInt(0);
        const newBalance = currentBalance + points;

        if (!balance) {
          await tx.pointBalance.create({
            data: { userId: pointTx.userId, balance: newBalance },
          });
        } else {
          await tx.pointBalance.update({
            where: { userId: pointTx.userId },
            data: { balance: newBalance },
          });
        }

        await tx.pointTransaction.update({
          where: { id_createdAt: txKey },
          data: {
            status: PointTransactionStatus.COMPLETED,
            amount: points,
            balanceBefore: currentBalance,
            balanceAfter: newBalance,
          },
        });

        return newBalance;
      });

      if (finalBalance === null) {
        this.logger.warn(
          `Point deposit (tx ${pointTx.txHash}) not credited: refId ${pointTx.refId} was already credited on another row`,
        );
        return;
      }

      // 8. Invalidate cache
      await this.pointsCache.invalidateBalance(pointTx.userId);

      this.logger.log(
        `Point deposit (tx ${pointTx.txHash}) completed: credited ${points} points to wallet ${truncateAddress(user.walletAddress)}`,
      );

      // Best-effort — a push failure must never fail (and re-trigger a
      // retry of) an already-completed deposit.
      const pointsFormatted = POINTS_NUMBER_FORMAT.format(points);
      const balanceFormatted = POINTS_NUMBER_FORMAT.format(finalBalance);
      await this.pushService
        .sendToUser({
          userId: pointTx.userId,
          title: `Congrats! +${pointsFormatted} points recieved 🎉`,
          body: `${pointsFormatted} points added, your total point is now ${balanceFormatted} points.`,
          data: {
            type: "point_deposit",
            pointTransactionId,
            status: "COMPLETED",
          },
          channelId: "points",
          source: "point_deposit",
        })
        .catch((err) => {
          this.logger.warn(
            `[point-deposit] push failed for tx ${pointTx.txHash}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      const outcome = classifySettlementError(error);
      this.logger.error(
        `Point deposit (tx ${pointTx.txHash}) ${outcome} (attempt ${job.attemptsMade + 1}): ${errorMessage}`,
      );

      if (outcome !== "transient") {
        // The chain has spoken; retrying cannot change it. Tell the user
        // the honest version and stop.
        await this.settleWithChainVerdict(
          pointTransactionId,
          new Date(pointTransactionCreatedAt),
          outcome,
          errorMessage,
        );
        return;
      }

      // Deliberately leave `status` as PENDING here. Flipping it to FAILED
      // on every attempt was the bug: the next BullMQ retry re-fetches
      // pointTx, sees status !== PENDING, and hits the guard above —
      // returning (resolving) instead of throwing. That silently ate every
      // configured retry (attempts: 5) after the first failure. Recording
      // the error in metadata (without touching status) preserves
      // debuggability while letting the retry actually re-run verification.
      await this.prisma.pointTransaction
        .update({
          where: { id_createdAt: txKey },
          data: {
            metadata: {
              lastError: errorMessage,
              lastAttemptAt: new Date().toISOString(),
              attemptsMade: job.attemptsMade,
            },
          },
        })
        .catch((metaErr) => {
          this.logger.warn(
            `[point-deposit] failed to record attempt metadata for tx ${pointTx.txHash}: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`,
          );
        });

      throw error; // Let BullMQ retry with backoff
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.log(`Point deposit job ${job.id} completed`);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<PointDepositJobData> | undefined, err: Error) {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? SETTLEMENT_MAX_ATTEMPTS;
    this.logger.error(
      `Point deposit job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`,
    );

    // Earlier attempts still have retries pending: say nothing. Only a
    // spent budget — every attempt transient, still no chain verdict —
    // reaches the user, and as "we're checking", not "failed".
    if (job.attemptsMade < maxAttempts) return;

    const { pointTransactionId, pointTransactionCreatedAt } = job.data;
    await this.settleWithChainVerdict(
      pointTransactionId,
      new Date(pointTransactionCreatedAt),
      "rejected_mismatch",
      `No chain verdict after ${maxAttempts} attempts: ${err.message}`,
    );
  }

  /**
   * Terminal handling. `rejected_reverted` = the chain refused the tx, so
   * nothing moved: FAILED + "you weren't charged". Anything else = the
   * money may have moved: stays PENDING, flagged `needsReview` in
   * metadata for ops, user told "we're checking". Never "contact
   * support", never a raw error string.
   */
  private async settleWithChainVerdict(
    pointTransactionId: string,
    createdAt: Date,
    outcome: "rejected_reverted" | "rejected_mismatch",
    errorMessage: string,
  ): Promise<void> {
    const txKey = { id: pointTransactionId, createdAt };

    const pointTx = await this.prisma.pointTransaction.findUnique({
      where: { id_createdAt: txKey },
      select: { userId: true, status: true, metadata: true },
    });

    // Guard against a race with a concurrent successful completion, and
    // against double-marking if this ever runs twice.
    if (!pointTx || pointTx.status !== PointTransactionStatus.PENDING) return;
    const priorMeta =
      pointTx.metadata && typeof pointTx.metadata === "object"
        ? (pointTx.metadata as Record<string, unknown>)
        : {};
    if (priorMeta.needsReview === true) return;

    const reverted = outcome === "rejected_reverted";
    await this.prisma.pointTransaction.update({
      where: { id_createdAt: txKey },
      data: reverted
        ? {
            status: PointTransactionStatus.FAILED,
            metadata: {
              ...priorMeta,
              error: errorMessage,
              failedAt: new Date().toISOString(),
            },
          }
        : {
            metadata: {
              ...priorMeta,
              needsReview: true,
              reviewReason: errorMessage,
              flaggedAt: new Date().toISOString(),
            },
          },
    });

    const copy = reverted
      ? {
          title: "Deposit didn't go through",
          body: "Your points deposit didn't go through and you weren't charged. You can try again anytime.",
          status: "FAILED",
        }
      : {
          title: "Still confirming your deposit",
          body: "We're still confirming your points deposit. You don't need to do anything, we'll update you once it's done.",
          status: "PENDING",
        };

    await this.pushService
      .sendToUser({
        userId: pointTx.userId,
        title: copy.title,
        body: copy.body,
        data: {
          type: "point_deposit",
          pointTransactionId,
          status: copy.status,
        },
        channelId: "points",
        source: "point_deposit",
      })
      .catch((pushErr) => {
        this.logger.warn(
          `[point-deposit] verdict push failed for ${pointTransactionId}: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
        );
      });
  }
}
