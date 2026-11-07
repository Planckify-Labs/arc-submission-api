import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { FulfilmentStatus } from "@generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import { FulfilmentService, POST_REFUND_WATCH_MS } from "./fulfilment.service";
import { LEGACY_QUEUED_AFTER_MS } from "./fulfilment-view";
import { FulfilmentKind } from "./fulfilment.types";

/** A SUBMITTED/DELAYED order nobody has asked the vendor about in this long lost its job. */
const STALE_CHECK_MS = 30 * 60 * 1000;
/** Don't hammer the vendor about orders from before the fulfilment leg existed. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 100;
/** Leaves an in-flight settle alone; it credits within moments of the flip. */
const STRANDED_REFUND_AFTER_MS = 10 * 60 * 1000;

/**
 * Safety net under the delayed-job chain: Valkey restarts, a deploy
 * mid-backoff, or a job that threw past its retries all leave an order
 * with nobody polling it. Every 10 minutes, any open order that has not
 * been checked recently gets one check (which re-arms its own chain).
 * Refunded orders inside the clawback window are included so a late
 * delivery is noticed.
 */
@Injectable()
export class FulfilmentSweeperService {
  private readonly logger = new Logger(FulfilmentSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: "fulfilment-sweeper" })
  async sweep(): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_CHECK_MS);
    const since = new Date(Date.now() - LOOKBACK_MS);
    const refundWatchSince = new Date(Date.now() - POST_REFUND_WATCH_MS);
    const legacyBefore = new Date(Date.now() - LEGACY_QUEUED_AFTER_MS);

    const openWhere = {
      vendorRefId: { not: null },
      OR: [
        {
          fulfilmentStatus: {
            in: [FulfilmentStatus.SUBMITTED, FulfilmentStatus.DELAYED],
          },
          createdAt: { gte: since },
        },
        {
          fulfilmentStatus: FulfilmentStatus.REFUNDED,
          createdAt: { gte: refundWatchSince },
        },
        // Accepted by the vendor but never entered the state machine;
        // `check` recovers these quietly (see `isLegacyQueued`).
        {
          fulfilmentStatus: FulfilmentStatus.QUEUED,
          createdAt: { lt: legacyBefore },
        },
      ],
      AND: [
        {
          OR: [
            { vendorLastCheckedAt: null },
            { vendorLastCheckedAt: { lt: staleBefore } },
          ],
        },
      ],
    };

    const [purchases, redemptions] = await Promise.all([
      this.prisma.purchase.findMany({
        where: openWhere,
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
      }),
      this.prisma.pointRedemption.findMany({
        where: openWhere,
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
      }),
    ]);

    const targets: Array<{ kind: FulfilmentKind; id: string }> = [
      ...purchases.map((p) => ({ kind: "purchase" as const, id: p.id })),
      ...redemptions.map((r) => ({ kind: "redemption" as const, id: r.id })),
    ];
    if (targets.length === 0) return 0;

    let checked = 0;
    for (const t of targets) {
      try {
        // attempt index past the tight part of the schedule: the sweeper
        // re-arms an hourly chain, not a 15-second one.
        await this.fulfilment.check(t.kind, t.id, {
          attempt: 8,
          reschedule: true,
        });
        checked++;
      } catch (err) {
        this.logger.warn(
          `[fulfilment-sweeper] ${t.kind} ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(
      `[fulfilment-sweeper] checked ${checked}/${targets.length} stale orders`,
    );
    return checked;
  }

  /**
   * A customer who paid must never sit at FAILED without their refund. If the
   * credit failed after the status flip, nothing else revisits the order.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: "fulfilment-stranded-refunds" })
  async sweepStrandedRefunds(): Promise<number> {
    const where = {
      fulfilmentStatus: FulfilmentStatus.FAILED,
      refund: null,
      updatedAt: { lt: new Date(Date.now() - STRANDED_REFUND_AFTER_MS) },
      createdAt: { gte: new Date(Date.now() - LOOKBACK_MS) },
    };
    const [purchases, redemptions] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
      }),
      this.prisma.pointRedemption.findMany({
        where,
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
      }),
    ]);
    const targets: Array<{ kind: FulfilmentKind; id: string }> = [
      ...purchases.map((p) => ({ kind: "purchase" as const, id: p.id })),
      ...redemptions.map((r) => ({ kind: "redemption" as const, id: r.id })),
    ];

    let retried = 0;
    for (const t of targets) {
      try {
        await this.fulfilment.finishStrandedRefund(t.kind, t.id);
        retried++;
      } catch (err) {
        this.logger.error(
          `[fulfilment-sweeper] stranded refund ${t.kind} ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (targets.length > 0) {
      this.logger.warn(
        `[fulfilment-sweeper] retried ${retried}/${targets.length} stranded refunds`,
      );
    }
    return retried;
  }
}
