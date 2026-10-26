import { Prisma } from "@generated/prisma";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { ValkeyService } from "../../valkey/valkey.service";
import {
  DeFiLlamaClient,
  DeFiLlamaYieldPool,
} from "../external/defillama.client";
import { ScoringService } from "../scoring/scoring.service";
import { oppRowCacheKey } from "../targets/cache-keys";
import type { DepositTarget } from "../targets/types";
import { MarketRiskClient } from "../external/market-risk.client";
import { resolveChainIdentity } from "../targets/chain-directory";
import { TargetResolverService } from "../targets/target-resolver.service";

interface ScorePoolJobData {
  pool: DeFiLlamaYieldPool;
}

/**
 * How long a previously validated `depositTarget` survives failed
 * re-validation. Long enough to ride out RPC flakiness, short enough that a
 * target that really has become invalid clears within a day.
 */
const TARGET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * DeFiLlama chain name → (namespace, chainId), sourced from the `Blockchain`
 * table through the chain directory — chains are **data, never a literal map**,
 * so onboarding a chain for DeFi is a seeded row, not an edit here.
 * `chainId` is 0 for non-EVM families (namespace is the discriminator there,
 * matching the OpportunityCache schema comment).
 *
 * An unknown chain keeps the previous default (`eip155`, chainId 0), which the
 * target resolver already reads as "no EVM deployment" → Manual path.
 */
function resolveChain(chainName: string): {
  namespace: string;
  chainId: number;
} {
  return resolveChainIdentity(chainName) ?? { namespace: "eip155", chainId: 0 };
}

// Concurrency 8: a poll enqueues ~250 pools, each doing a (sometimes flaky/slow)
// DeFiLlama metadata + resolver fetch. At the BullMQ default of 1 the queue
// can't keep pace with the 30-min poll cadence and newly-added pools (e.g. the
// synthesized Sui LST rows) sit unscored for a long time. Parallelising drains
// it quickly; most metadata is Valkey-cached so this doesn't hammer DeFiLlama.

export interface PreviousTarget {
  depositTarget: unknown;
  targetResolvedAt: Date | null;
}

export interface TargetWriteDecision {
  target: Prisma.OpportunityCacheUpdateInput["depositTarget"];
  resolvedAt: Date | null;
  keptPrevious: boolean;
}

/**
 * Decide what to persist for `depositTarget`, given what the resolver just said
 * and what was already stored.
 *
 * A NULL result means one of two very different things, and by the time it
 * reaches the processor they are indistinguishable: the resolver genuinely
 * refused, or it could not check. Every validator ends in
 * `catch { return false }` and `TargetResolverService.resolve` ends in
 * `catch { return null }`, so one flaky RPC read looks exactly like "this pool
 * is not depositable".
 *
 * That is not theoretical. Measured 2026-08-21: four Aave v3 reserves
 * (Ethereum cbBTC, Base cbBTC, Ethereum rETH, Arbitrum weETH) were persisted as
 * NULL by this worker while `pnpm defi:dry-run --protocol aave-v3` resolved all
 * four against the same chain state and the same pinned Pool addresses. Across
 * three device captures aave-v3 read 19/33, then 26/33, then 21/33 with no code
 * change touching Aave — a deterministic resolver cannot produce three answers.
 * This worker runs at concurrency 8 against one RPC proxy; the dry run does not.
 *
 * So a null NEVER overwrites a target that was validated recently. The pool is
 * retried on the next tick, and if it keeps failing for the whole grace window
 * the target does clear — bounding how long a genuinely dead target can survive
 * to one day, while the flapping disappears entirely.
 *
 * `resolvedAt` is deliberately NOT refreshed when the previous target is kept:
 * the window is measured from the last SUCCESSFUL validation, so repeated
 * failures cannot extend it indefinitely.
 */
export function decideTargetWrite(
  resolved: unknown,
  previous: PreviousTarget | null,
  nowMs: number,
): TargetWriteDecision {
  if (resolved) {
    return {
      target: resolved as Prisma.InputJsonValue,
      resolvedAt: new Date(nowMs),
      keptPrevious: false,
    };
  }
  const withinGrace =
    previous?.depositTarget != null &&
    previous.targetResolvedAt != null &&
    nowMs - previous.targetResolvedAt.getTime() < TARGET_GRACE_MS;

  return withinGrace
    ? {
        target: previous?.depositTarget as Prisma.InputJsonValue,
        resolvedAt: previous?.targetResolvedAt ?? null,
        keptPrevious: true,
      }
    : { target: Prisma.DbNull, resolvedAt: null, keptPrevious: false };
}

/**
 * How many pools are scored in parallel.
 *
 * A poll enqueues ~300 pools, each doing a DeFiLlama metadata lookup, a
 * discovery fetch and several `eth_call`s. At the BullMQ default of 1 the queue
 * cannot keep pace with the 30-minute cadence and newly-added pools sit
 * unscored; 8 drains it comfortably.
 *
 * It is CONFIGURABLE because the right value depends on the uplink, not on the
 * code. Measured 2026-08-21: 16 parallel requests to api.llama.fi from a bare
 * Node process succeeded 16/16 in 1.7s, while this worker was taking
 * `UND_ERR_CONNECT_TIMEOUT` at 10s against that same host — the difference is
 * everything else the process does concurrently (RPC-proxy calls, several
 * discovery APIs) sharing one uplink. On a slow or contended link, FEWER
 * parallel jobs finish MORE pools per tick than more parallel jobs that all
 * time out.
 *
 * Lower it (`SCORE_CONCURRENCY=3`) when the logs show connect timeouts; raise
 * it on a fat pipe. Nothing here is unsafe either way: a pool that cannot be
 * scored keeps its previous target (see `decideTargetWrite`) or stays Manual.
 */
function scoreConcurrency(): number {
  const raw = Number.parseInt(process.env.SCORE_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

export interface PreviousScore {
  score: number;
  tier: string;
}

/**
 * Keep the previous score when this pass could not read the protocol's
 * metadata.
 *
 * The tier rules read `auditCount: 0` as "unaudited" (aggressive), and a
 * failed lookup returns `auditCount: 0`. So a network timeout does not
 * merely lose information — it actively asserts "unaudited" and takes 45 points
 * off a dimension. That moves the composite score, which moves the TIER, and
 * the opportunity list is filtered by tier. The pool then vanishes from the
 * app rather than merely losing its in-app badge, which is strictly worse and
 * much harder to notice.
 *
 * Measured 2026-08-21: as `api.llama.fi` lookups started timing out, the EVM
 * row count fell 169 → 141 and `sparklend` went from 5 visible pools to 1 —
 * with no change to Spark, to the scorer, or to the pools themselves.
 *
 * A degraded read therefore keeps whatever was computed from a GOOD read. With
 * no previous score there is nothing to keep, so the degraded value stands —
 * a new pool still gets scored, just conservatively.
 */
export function decideScoreWrite(
  fresh: { score: number; tier: string },
  degradedMetadata: boolean,
  previous: PreviousScore | null,
): { score: number; tier: string; keptPrevious: boolean } {
  if (!degradedMetadata || !previous) return { ...fresh, keptPrevious: false };
  return { score: previous.score, tier: previous.tier, keptPrevious: true };
}

@Processor("score-opportunities", { concurrency: scoreConcurrency() })
export class ScoreOpportunitiesProcessor extends WorkerHost {
  private readonly logger = new Logger(ScoreOpportunitiesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoringService: ScoringService,
    private readonly defillama: DeFiLlamaClient,
    private readonly targetResolver: TargetResolverService,
    private readonly valkey: ValkeyService,
    private readonly marketRisk: MarketRiskClient,
  ) {
    super();
  }

  async process(job: Job<ScorePoolJobData>): Promise<void> {
    const { pool } = job.data;
    this.logger.debug(
      `Scoring pool ${pool.pool} (${pool.symbol} on ${pool.project})`,
    );

    try {
      const protocolMetadata = await this.defillama.getProtocolMetadata(
        pool.project,
      );

      // The chain directory is DB-backed, so make sure it is loaded before the
      // (synchronous) name → namespace/chainId lookup below.
      await this.targetResolver.ensureChainDirectory();
      const { namespace, chainId } = resolveChain(pool.chain);

      // Pool-level deposits (spec §3, §4.2, §6): resolve the on-chain deposit
      // target from the pool's matching keys, on-chain-validated. `null` ⇒ the
      // pool degrades to the manual deep-link path (fail-closed).
      const depositTarget = await this.targetResolver.resolve(pool);
      const poolMeta = pool.poolMeta ?? null;
      const assetContract =
        typeof pool.underlyingTokens?.[0] === "string"
          ? pool.underlyingTokens[0].toLowerCase()
          : null;
      const previous = await this.prisma.opportunityCache
        .findUnique({
          where: { poolId: pool.pool },
          select: {
            depositTarget: true,
            targetResolvedAt: true,
            score: true,
            tier: true,
            tierReasons: true,
          },
        })
        .catch(() => null);

      const decision = decideTargetWrite(depositTarget, previous, Date.now());
      if (decision.keptPrevious) {
        this.logger.warn(
          `[score] pool ${pool.pool} (${pool.project}) resolved to null but a target ` +
            `validated at ${previous?.targetResolvedAt?.toISOString()} is still within the ` +
            `grace window — keeping it and retrying next tick rather than badging Manual.`,
        );
      }
      const targetJson = decision.target;
      const targetResolvedAt = decision.resolvedAt;

      // Exit-side risk (exploits, lending liquidity, LST peg) for the target
      // the row will carry. Never throws: no signals is "nothing claimed".
      const finalTarget =
        targetJson && typeof targetJson === "object"
          ? (targetJson as unknown as DepositTarget)
          : null;
      const riskSignals = await this.marketRisk
        .forPool(pool, finalTarget)
        .catch(() => null);
      const riskJson = riskSignals
        ? (riskSignals as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull;

      // Tier by rules over the facts gathered above (scoring.service.ts). A
      // failed metadata read leaves audits UNKNOWN, never "unaudited".
      const fresh = this.scoringService.assess({
        pool,
        auditCount: protocolMetadata.degraded
          ? null
          : protocolMetadata.auditCount,
        target: finalTarget,
        riskSignals,
      });
      const scoreDecision = decideScoreWrite(
        fresh,
        protocolMetadata.degraded,
        previous ? { score: previous.score, tier: previous.tier } : null,
      );
      if (scoreDecision.keptPrevious) {
        this.logger.warn(
          `[score] pool ${pool.pool} (${pool.project}) scored with DEGRADED metadata ` +
            `(the DeFiLlama lookup failed) — keeping the previous score ` +
            `${previous?.score}/${previous?.tier} instead of letting a network ` +
            `failure re-tier the pool.`,
        );
      }
      const { score, tier } = scoreDecision;
      const tierReasons = (
        scoreDecision.keptPrevious && previous?.tierReasons != null
          ? previous.tierReasons
          : fresh.reasons
      ) as Prisma.InputJsonValue;

      // Upsert into OpportunityCache
      await this.prisma.opportunityCache.upsert({
        where: { poolId: pool.pool },
        update: {
          protocolSlug: pool.project,
          chainId,
          namespace,
          chainName: pool.chain,
          assetSymbol: pool.symbol,
          assetContract,
          poolMeta,
          depositTarget: targetJson,
          targetResolvedAt,
          riskSignals: riskJson,
          apy: pool.apy,
          apy7dAvg: pool.apy7d || pool.apy,
          apyStddev30d: pool.sigma ?? 0,
          tvlUsd: pool.tvlUsd,
          tvl7dDelta: 0,
          ilExposure: pool.ilRisk === "yes",
          score,
          tier,
          tierReasons,
          raw: pool as unknown as Prisma.InputJsonValue,
          scoredAt: new Date(),
        },
        create: {
          poolId: pool.pool,
          protocolSlug: pool.project,
          chainId,
          namespace,
          chainName: pool.chain,
          assetSymbol: pool.symbol,
          assetContract,
          poolMeta,
          depositTarget: targetJson,
          targetResolvedAt,
          riskSignals: riskJson,
          apy: pool.apy,
          apy7dAvg: pool.apy7d || pool.apy,
          apyStddev30d: pool.sigma ?? 0,
          tvlUsd: pool.tvlUsd,
          tvl7dDelta: 0,
          ilExposure: pool.ilRisk === "yes",
          score,
          tier,
          tierReasons,
          raw: pool as unknown as Prisma.InputJsonValue,
          scoredAt: new Date(),
        },
      });

      // Persist protocol-level metadata (safety + app URL for the manual
      // deep-link homepage fallback, spec §9.1). Protocol-scoped, so it isn't
      // duplicated per sibling pool.
      await this.prisma.protocolScoreCache
        .upsert({
          where: { protocolSlug: pool.project },
          update: {
            // Legacy column with no readers; the tier rules replaced it.
            safetyScore: protocolMetadata.auditCount > 0 ? 85 : 40,
            auditCount: protocolMetadata.auditCount,
            appUrl: protocolMetadata.appUrl,
            ...(riskSignals
              ? { exploitHistoryFlag: riskSignals.exploit !== undefined }
              : {}),
            computedAt: new Date(),
          },
          create: {
            protocolSlug: pool.project,
            // Legacy column with no readers; the tier rules replaced it.
            safetyScore: protocolMetadata.auditCount > 0 ? 85 : 40,
            auditCount: protocolMetadata.auditCount,
            protocolAgeDays: 0,
            exploitHistoryFlag: riskSignals?.exploit !== undefined,
            tvlTrendBps: 0,
            appUrl: protocolMetadata.appUrl,
            computedAt: new Date(),
          },
        })
        .catch((err) => {
          this.logger.warn(
            `ProtocolScoreCache upsert failed for ${pool.project}: ${err?.message ?? err}`,
          );
        });

      // Invalidate the Valkey row cache so the executor's authoritative
      // depositTarget re-fetch (§6) sees the fresh row.
      await this.valkey.del(oppRowCacheKey(pool.pool)).catch(() => undefined);

      this.logger.debug(
        `Saved score ${score} (${tier}) for pool ${pool.pool} (target=${depositTarget?.kind ?? "manual"})`,
      );
    } catch (error) {
      this.logger.error(`Failed to score pool ${pool.pool}: ${error.message}`);
      throw error;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`Scoring job ${job.id} completed`);
  }
}
