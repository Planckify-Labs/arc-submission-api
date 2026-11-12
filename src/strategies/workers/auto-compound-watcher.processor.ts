import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { PushService } from "../../push/push.service";

const DEFAULT_INTERVAL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Auto-compound watcher (spec §21.3, ships with the auto-compound
 * opt-in toggle).
 *
 * Scans active positions belonging to users who opted in
 * (`UserStrategy.autoCompound = true`) and pushes a "time to
 * compound" nudge once per interval window. Mobile receives the
 * push, opens the position, and calls `defi_compound` — the
 * executor's own balance-delta check decides if anything's actually
 * claimable (returns `no_claimable_balance` gracefully when not).
 *
 * Dedup: `StrategyPositionEvent` row with `kind =
 * "auto_compound_nudge:<bucket>"` where `bucket = floor(daysSinceEpoch
 * / intervalDays)`. The unique constraint on (positionId, kind)
 * guarantees one nudge per window even if the cron fires multiple
 * times within it.
 *
 * V1 is time-based on purpose — the mobile executor already has
 * authoritative "is there anything to compound" logic, and per-adapter
 * server-side claimable-balance readers would mean duplicating each
 * protocol's claim semantics on the backend. The signal-fidelity
 * upgrade (read claimable balance, push only when > $X) is a clean
 * V1.1 layer on top of this dedup scaffolding.
 */
@Processor("auto-compound-watcher")
export class AutoCompoundWatcherProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoCompoundWatcherProcessor.name);
  private readonly intervalDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    private readonly configService: ConfigService,
  ) {
    super();
    const raw = this.configService.get<string>(
      "DEFI_AUTO_COMPOUND_INTERVAL_DAYS",
    );
    const parsed = Number(raw);
    this.intervalDays =
      Number.isFinite(parsed) && parsed >= 1
        ? Math.floor(parsed)
        : DEFAULT_INTERVAL_DAYS;
  }

  async process(_job: Job): Promise<void> {
    const now = Date.now();
    const bucket = Math.floor(now / MS_PER_DAY / this.intervalDays);
    const kind = `auto_compound_nudge:${bucket}`;
    this.logger.log(
      `[auto-compound-watcher] scanning (intervalDays=${this.intervalDays}, bucket=${bucket})`,
    );

    const positions = await this.prisma.strategyPosition.findMany({
      where: {
        status: "active",
        userStrategy: { autoCompound: true },
      },
      include: {
        userStrategy: {
          select: { id: true, userId: true, autoCompound: true },
        },
      },
    });

    let pushed = 0;
    let skippedDedup = 0;
    let skippedNoTokens = 0;

    for (const position of positions) {
      const claimed = await this.tryRecordEvent(position.id, kind);
      if (!claimed) {
        skippedDedup += 1;
        continue;
      }

      const result = await this.pushService.sendToUser({
        userId: position.userStrategy.userId,
        title: "Time to compound",
        body: `Tap to claim and redeposit rewards on your ${position.assetSymbol} position.`,
        data: {
          kind: "auto_compound_nudge",
          positionId: position.id,
          protocolSlug: position.protocolSlug,
          chainId: position.chainId,
          // Replayed into the agent on tap (mobile `tapRoutes.ts`), which
          // has the compound tool; the write still needs user approval.
          prompt: `Compound the rewards on my ${position.assetSymbol} position on ${position.protocolSlug}.`,
        },
        channelId: "strategies",
      });

      if (result.attempted === 0) {
        skippedNoTokens += 1;
      } else {
        pushed += 1;
      }
    }

    this.logger.log(
      `[auto-compound-watcher] scan complete. positions=${positions.length} pushed=${pushed} skipped_dedup=${skippedDedup} skipped_no_tokens=${skippedNoTokens}`,
    );
  }

  /**
   * Same dedup pattern as `goal-deadline-watcher`. Returns `true`
   * when this call wrote the row.
   */
  private async tryRecordEvent(
    positionId: string,
    kind: string,
  ): Promise<boolean> {
    try {
      await this.prisma.strategyPositionEvent.create({
        data: { positionId, kind },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Unique") || message.includes("P2002")) {
        return false;
      }
      throw err;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`Auto-compound watcher job ${job.id} completed`);
  }
}
