import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { Prisma } from "@generated/prisma";
import {
  DeFiLlamaClient,
  DeFiLlamaYieldPool,
} from "../external/defillama.client";
import { MarketProtocolPoolsSource } from "../external/market-protocol-pools.source";
import { SuiLstSource } from "../external/sui-lst.source";
import { PrismaService } from "../../prisma/prisma.service";
import { TargetResolverService } from "../targets/target-resolver.service";

/**
 * How many cached-but-unfed pools get re-resolved per tick. Bounded because
 * each one costs an on-chain validation round trip.
 */
const DEFAULT_RERESOLVE_BATCH = 150;

/** A resolved target older than this is re-validated rather than trusted. */
const TARGET_REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

@Processor("defillama-poll")
export class DefiLlamaPollProcessor extends WorkerHost {
  private readonly logger = new Logger(DefiLlamaPollProcessor.name);

  constructor(
    private readonly defillama: DeFiLlamaClient,
    private readonly suiLstSource: SuiLstSource,
    private readonly protocolPools: MarketProtocolPoolsSource,
    private readonly prisma: PrismaService,
    private readonly targetResolver: TargetResolverService,
    @InjectQueue("score-opportunities") private readonly scoringQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log("Starting DeFiLlama yield pool poll...");

    try {
      // Which chains to keep is the chain directory (DB-backed); load it before
      // the feed is filtered against it.
      await this.targetResolver.ensureChainDirectory();
      const feedPools = await this.defillama.getYieldPools();
      // Sui liquid-staking venues aren't in DeFiLlama's /pools — synthesize their
      // rows (real APY + TVL) and append so they flow through the same scoring +
      // target-resolution path. Failure here must not sink the whole poll.
      const lstPools = await this.suiLstSource.getPools().catch((err) => {
        this.logger.error(`Sui LST source failed: ${err.message}`);
        return [];
      });
      // Pools read from protocols' own APIs (via the market API) on chains the
      // feed has none for, e.g. Morpho Vault V2 on Arc. Never sinks the poll.
      const sourcedPools = await this.protocolPools.getPools();
      const pools = [...feedPools, ...lstPools, ...sourcedPools];
      this.logger.log(
        `Fetched ${feedPools.length} pools from DeFiLlama (+${lstPools.length} synthesized Sui LST, +${sourcedPools.length} from protocol APIs)`,
      );

      // In a real implementation, we might save the raw data or update a temporary cache
      // For Phase 1, we'll just pass the data to the scoring processor
      for (const pool of pools) {
        await this.scoringQueue.add(
          "score-pool",
          { pool },
          {
            removeOnComplete: true,
            jobId: `score-${pool.pool}`, // Idempotency
          },
        );
      }

      this.logger.log(`Enqueued ${pools.length} pools for scoring`);

      await this.enqueueStaleCachedPools(new Set(pools.map((p) => p.pool)));
    } catch (error) {
      this.logger.error(`Failed to poll DeFiLlama: ${error.message}`);
      throw error;
    }
  }

  /**
   * Re-score cached pools the live feed did NOT cover.
   *
   * The read path and the write path used to disagree about which pools exist.
   * `getYieldPools()` is capped (300 total, 50 per chain, ≥$5M) and only those
   * pools are enqueued, but `getOpportunities()` serves **every** row in
   * `OpportunityCache` — 377 of them, the oldest last scored five weeks ago.
   * A row that drops out of DeFiLlama's top-N window is therefore frozen
   * forever at whatever `depositTarget` it had when it was last seen.
   *
   * That is why protocols kept showing "Manual" in the app after their
   * resolvers had been fixed: the rows scored while discovery was broken still
   * carried `depositTarget: null`, and nothing ever asked again. Measured
   * 2026-08-21: 377 cached rows, only 47 with a target, while the dry run
   * resolved 217/583 against the same chain state.
   *
   * Stale NON-null targets are refreshed too. `targetResolvedAt` exists to
   * "drive periodic re-validation" per the schema, and nothing was driving it —
   * so a pinned address that stopped validating would have kept its in-app
   * badge indefinitely. Re-validation is what flips it back to Manual.
   *
   * Bounded per tick and ordered by TVL, so the RPC budget stays predictable
   * and the pools users are most likely to see are refreshed first.
   */
  private async enqueueStaleCachedPools(
    fedPoolIds: Set<string>,
  ): Promise<void> {
    const limit = Number.parseInt(
      process.env.DEFILLAMA_RERESOLVE_BATCH ?? "",
      10,
    );
    const batch =
      Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_RERESOLVE_BATCH;

    const cutoff = new Date(Date.now() - TARGET_REVALIDATE_AFTER_MS);
    const rows = await this.prisma.opportunityCache
      .findMany({
        where: {
          poolId: { notIn: [...fedPoolIds] },
          OR: [
            { depositTarget: { equals: Prisma.DbNull } },
            { targetResolvedAt: null },
            { targetResolvedAt: { lt: cutoff } },
          ],
        },
        // Oldest first. This was TVL-descending, and the ~390 Manual rows
        // (always eligible) filled every 150-row batch with the same
        // high-TVL pools, so a smaller resolved row was never picked again:
        // found 2026-10-26 serving Lista and Auto Finance vaults whose TVL
        // and APY were 17 days old (scoredAt 2026-10-09). Oldest-first is a
        // round robin; every row gets its turn.
        orderBy: { scoredAt: "asc" },
        take: batch,
        select: { poolId: true, raw: true },
      })
      .catch((err) => {
        this.logger.error(`Stale-pool lookup failed: ${err.message}`);
        return [];
      });

    let enqueued = 0;
    for (const row of rows) {
      // `raw` is the DeFiLlamaYieldPool the row was built from, so the pool can
      // be re-scored without the feed. A row whose payload predates that field
      // (or is malformed) is skipped rather than guessed at — the resolver
      // needs `chain`/`project`/`symbol` to match anything at all.
      // Re-score from what DeFiLlama lists NOW, not from the copy stored when
      // the row was first seen: a re-score of stale TVL/APY would re-stamp
      // old numbers as fresh, and fail the TVL band against the vault's real
      // size. A pool missing from a current feed is no longer listed at all;
      // it is not re-scored, and ages out of the listing (getOpportunities).
      const fromFeed = this.defillama.feedPool(row.poolId);
      if (fromFeed === null) continue;
      const pool = fromFeed ?? asYieldPool(row.raw);
      if (!pool) continue;
      await this.scoringQueue.add(
        "score-pool",
        { pool },
        { removeOnComplete: true, jobId: `score-${pool.pool}` },
      );
      enqueued++;
    }

    if (rows.length > 0) {
      this.logger.log(
        `Re-enqueued ${enqueued}/${rows.length} cached pools outside the feed window ` +
          `(missing or stale depositTarget)`,
      );
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.log(`DeFiLlama poll job ${job.id} completed`);
  }
}

/** Narrow a stored `raw` payload back to a pool, or null when it is not one. */
function asYieldPool(raw: unknown): DeFiLlamaYieldPool | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<DeFiLlamaYieldPool>;
  return typeof p.pool === "string" &&
    typeof p.chain === "string" &&
    typeof p.project === "string" &&
    typeof p.symbol === "string"
    ? (raw as DeFiLlamaYieldPool)
    : null;
}
