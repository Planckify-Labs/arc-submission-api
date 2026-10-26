import { Injectable } from "@nestjs/common";
import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import type { RiskSignals } from "../external/market-risk.client";
import type { DepositTarget } from "../targets/types";

/**
 * Risk tier and ranking for one pool.
 *
 * The tier is a product promise: the agent never proposes a pool above the
 * user's saved tier, and Quick Invest's risk dial filters on it. So it is
 * assigned by RULES over facts, each one a reason the app can show ("why is
 * this aggressive?"), rather than a weighted composite of guesses. The old
 * composite read audits as yes/no, bucketed APY and TVL, scored chains from a
 * hardcoded list, and had three permanently-zero inputs.
 *
 * Fund safety does NOT live here. Whether a pool can be deposited into at all
 * is decided by the target validators (identity, TVL band, exit cost, holder
 * exit, cooldown) and the device's safety pipeline (exploit pause, policy).
 *
 * Thresholds were set from the live feed on 2026-10-26 (1,255 ingested
 * pools): APY volatility (`sigma`) median 0.11, p90 1.47, blue chips 0.04 to
 * 0.15; APY median 4%, p90 13.6%, p95 26.8%. All are ops-overridable.
 */

export type Tier = "conservative" | "balanced" | "aggressive";

export type TierReason =
  | "impermanent_loss"
  | "multi_asset"
  | "very_high_apy"
  | "high_apy"
  | "volatile_apy"
  | "variable_apy"
  | "apy_outlier"
  | "small_pool"
  | "modest_pool"
  | "unaudited"
  | "exploit_unreturned"
  | "exploit_returned"
  | "low_liquidity"
  | "lst_discount"
  | "exit_queue";

export interface TierAssessment {
  tier: Tier;
  /** 0-100, for ordering: safest tier first, then realistic yield. */
  score: number;
  reasons: TierReason[];
}

export interface TierInput {
  pool: DeFiLlamaYieldPool;
  /** null = could not be read (the lookup failed): not "unaudited". */
  auditCount: number | null;
  target: DepositTarget | null;
  riskSignals: RiskSignals | null;
}

const RANK: Record<Tier, number> = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
};
const TIER_BASE: Record<Tier, number> = {
  conservative: 80,
  balanced: 50,
  aggressive: 0,
};

function env(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The APY a ranking may rest on: DeFiLlama's 30-day mean, else current. */
export function realisticApy(pool: DeFiLlamaYieldPool): number {
  const mean = pool.apyMean30d;
  return typeof mean === "number" && Number.isFinite(mean) ? mean : pool.apy;
}

@Injectable()
export class ScoringService {
  assess({ pool, auditCount, target, riskSignals }: TierInput): TierAssessment {
    const found: Array<[TierReason, Tier]> = [];
    const flag = (reason: TierReason, tier: Tier) => found.push([reason, tier]);

    if (pool.ilRisk === "yes") flag("impermanent_loss", "aggressive");
    else if (pool.exposure === "multi") flag("multi_asset", "balanced");

    const apy = realisticApy(pool);
    if (apy >= env("DEFI_TIER_APY_AGGRESSIVE", 25))
      flag("very_high_apy", "aggressive");
    else if (apy >= env("DEFI_TIER_APY_BALANCED", 12))
      flag("high_apy", "balanced");

    if (typeof pool.sigma === "number") {
      if (pool.sigma >= env("DEFI_TIER_SIGMA_AGGRESSIVE", 1))
        flag("volatile_apy", "aggressive");
      else if (pool.sigma >= env("DEFI_TIER_SIGMA_BALANCED", 0.3))
        flag("variable_apy", "balanced");
    }
    if (pool.outlier === true) flag("apy_outlier", "aggressive");

    if (pool.tvlUsd < env("DEFI_TIER_TVL_AGGRESSIVE_USD", 1_000_000))
      flag("small_pool", "aggressive");
    else if (pool.tvlUsd < env("DEFI_TIER_TVL_BALANCED_USD", 10_000_000))
      flag("modest_pool", "balanced");

    if (auditCount === 0) flag("unaudited", "aggressive");

    const exploit = riskSignals?.exploit;
    if (riskSignals?.warnings.includes("recent_exploit")) {
      flag("exploit_unreturned", "aggressive");
    } else if (exploit && riskSignals?.warnings.includes("past_exploit")) {
      flag(
        exploit.lostUsd > exploit.returnedUsd
          ? "exploit_unreturned"
          : "exploit_returned",
        exploit.lostUsd > exploit.returnedUsd ? "aggressive" : "balanced",
      );
    }
    if (riskSignals?.warnings.includes("low_liquidity"))
      flag("low_liquidity", "balanced");
    if (riskSignals?.warnings.includes("lst_discount"))
      flag("lst_discount", "balanced");

    if (target?.kind === "lst-stake" && target.exit === "queue")
      flag("exit_queue", "balanced");

    const tier = found.reduce<Tier>(
      (worst, [, t]) => (RANK[t] > RANK[worst] ? t : worst),
      "conservative",
    );
    // Within a tier, higher realistic yield first; capped so an outlier APY
    // cannot buy its way up a band.
    const yieldPoints = Math.round((Math.min(Math.max(apy, 0), 20) / 20) * 19);
    return {
      tier,
      score: TIER_BASE[tier] + yieldPoints,
      reasons: [...new Set(found.map(([r]) => r))],
    };
  }
}
