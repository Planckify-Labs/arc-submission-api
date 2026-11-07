import { ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  PointTransactionStatus,
  PointTransactionType,
  Prisma,
  PointsHoldStatus,
} from "@generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import { PointsCacheService } from "../valkey/services/points-cache.service";

export type ConsumeResult = "CONSUMED" | "NONE" | "RELEASED";

/**
 * The points half of a points + tokens purchase.
 *
 * A booking that uses points takes them up front (HELD). Every later
 * transition is a compare-and-set from HELD, so exactly one outcome wins even
 * when the sweep, a cancel, the purchase worker and a refund race:
 *
 *   HELD -> CONSUMED  the payment arrived; the points are spent for good
 *   HELD -> RELEASED  the booking never got paid; points go back
 *
 * Balance moves are single atomic statements, never read-then-write.
 * `PointTransaction` is a hypertable (no FK, no unique index), so the CAS on
 * the booking row is the idempotency guard.
 */
@Injectable()
export class PointsHoldService {
  private readonly logger = new Logger(PointsHoldService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pointsCache: PointsCacheService,
  ) {}

  async balanceOf(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<bigint> {
    const row = await tx.pointBalance.findUnique({ where: { userId } });
    return row?.balance ?? 0n;
  }

  /**
   * Inside the caller's transaction, after the booking row exists: guarded
   * decrement (loses -> conflict, the whole transaction rolls back), SPEND
   * ledger row referencing the booking, and the ledger pointer on the booking.
   */
  async holdInTx(
    tx: Prisma.TransactionClient,
    input: { userId: string; bookingId: string; points: bigint },
  ): Promise<void> {
    const { userId, bookingId, points } = input;
    const guarded = await tx.pointBalance.updateMany({
      where: { userId, balance: { gte: points } },
      data: { balance: { decrement: points } },
    });
    if (guarded.count !== 1) {
      throw new ConflictException(
        "Your points balance changed while booking. Please try again.",
      );
    }
    const after = await tx.pointBalance.findUniqueOrThrow({
      where: { userId },
      select: { balance: true },
    });
    const ptx = await tx.pointTransaction.create({
      data: {
        userId,
        type: PointTransactionType.SPEND,
        status: PointTransactionStatus.COMPLETED,
        amount: -points,
        balanceBefore: after.balance + points,
        balanceAfter: after.balance,
        referenceType: "BOOKING",
        referenceId: bookingId,
        metadata: { hold: true } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });
    await tx.bookingOrder.update({
      where: { id: bookingId },
      data: {
        pointTransactionId: ptx.id,
        pointTransactionCreatedAt: ptx.createdAt,
      },
    });
  }

  /** Drop the cached balance after a transaction that moved it committed. */
  async invalidate(userId: string): Promise<void> {
    await this.pointsCache.invalidateBalance(userId);
  }

  /**
   * HELD -> RELEASED, credit and REFUND ledger row in one transaction.
   * Returns whether THIS call released it; a second call is a no-op.
   */
  async release(bookingId: string, reason: string): Promise<boolean> {
    const released = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.bookingOrder.updateMany({
        where: { id: bookingId, pointsHoldStatus: PointsHoldStatus.HELD },
        data: { pointsHoldStatus: PointsHoldStatus.RELEASED },
      });
      if (flipped.count !== 1) return null;

      const booking = await tx.bookingOrder.findUniqueOrThrow({
        where: { id: bookingId },
        select: {
          pointsApplied: true,
          pointTransactionId: true,
          pointTransactionCreatedAt: true,
        },
      });
      const userId = await this.holderOf(tx, bookingId, booking);
      const points = booking.pointsApplied;

      await tx.pointBalance.upsert({
        where: { userId },
        create: { userId, balance: points },
        update: { balance: { increment: points } },
      });
      const after = await tx.pointBalance.findUniqueOrThrow({
        where: { userId },
        select: { balance: true },
      });
      await tx.pointTransaction.create({
        data: {
          userId,
          type: PointTransactionType.REFUND,
          status: PointTransactionStatus.COMPLETED,
          amount: points,
          balanceBefore: after.balance - points,
          balanceAfter: after.balance,
          referenceType: "BOOKING",
          referenceId: bookingId,
          metadata: { holdReleased: true, reason } as Prisma.InputJsonValue,
        },
      });
      return userId;
    });

    if (released === null) return false;
    await this.pointsCache.invalidateBalance(released);
    this.logger.log(`[points-hold] released booking ${bookingId}: ${reason}`);
    return true;
  }

  /**
   * HELD -> CONSUMED. Already CONSUMED is fine (a retry); NONE means the
   * booking never used points; RELEASED means the points already went back.
   */
  async consume(bookingId: string): Promise<ConsumeResult> {
    const flipped = await this.prisma.bookingOrder.updateMany({
      where: { id: bookingId, pointsHoldStatus: PointsHoldStatus.HELD },
      data: { pointsHoldStatus: PointsHoldStatus.CONSUMED },
    });
    if (flipped.count === 1) return "CONSUMED";
    const row = await this.prisma.bookingOrder.findUnique({
      where: { id: bookingId },
      select: { pointsHoldStatus: true },
    });
    switch (row?.pointsHoldStatus) {
      case PointsHoldStatus.CONSUMED:
        return "CONSUMED";
      case PointsHoldStatus.RELEASED:
        return "RELEASED";
      default:
        return "NONE";
    }
  }

  /**
   * Holds nobody paid for: still HELD, no purchase, and past `olderThan`.
   * One failure never stops the rest. Returns how many were released.
   */
  async releaseStale(olderThan: Date, batch = 100): Promise<number> {
    const stale = await this.prisma.bookingOrder.findMany({
      where: {
        pointsHoldStatus: PointsHoldStatus.HELD,
        purchase: null,
        expiresAt: { lt: olderThan },
      },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: batch,
    });
    let released = 0;
    for (const { id } of stale) {
      try {
        if (await this.release(id, "booking expired unpaid")) released += 1;
      } catch (err) {
        this.logger.warn(
          `[points-hold] could not release booking ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return released;
  }

  /** The user whose balance paid, from the booking's SPEND ledger row (primary-key lookup). */
  private async holderOf(
    tx: Prisma.TransactionClient,
    bookingId: string,
    booking: {
      pointTransactionId: string | null;
      pointTransactionCreatedAt: Date | null;
    },
  ): Promise<string> {
    if (!booking.pointTransactionId || !booking.pointTransactionCreatedAt) {
      throw new Error(`Held booking ${bookingId} has no SPEND ledger pointer`);
    }
    const spend = await tx.pointTransaction.findUnique({
      where: {
        id_createdAt: {
          id: booking.pointTransactionId,
          createdAt: booking.pointTransactionCreatedAt,
        },
      },
      select: { userId: true },
    });
    if (!spend) {
      throw new Error(`No SPEND ledger row for held booking ${bookingId}`);
    }
    return spend.userId;
  }
}
