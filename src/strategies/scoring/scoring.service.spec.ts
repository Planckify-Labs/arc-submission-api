import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import type { RiskSignals } from "../external/market-risk.client";
import { ScoringService, realisticApy } from "./scoring.service";

/**
 * Tier rules. The tier is a promise ("never above your risk level"), so the
 * cases pin which facts move a pool up and that every move names its reason.
 */

const s = new ScoringService();

function pool(overrides: Partial<DeFiLlamaYieldPool> = {}): DeFiLlamaYieldPool {
  return {
    pool: "p",
    chain: "Ethereum",
    project: "sky-lending",
    symbol: "SUSDS",
    tvlUsd: 4_800_000_000,
    apy: 3.8,
    apyMean30d: 3.8,
    sigma: 0.036,
    outlier: false,
    ilRisk: "no",
    exposure: "single",
    ...overrides,
  };
}

const signals = (overrides: Partial<RiskSignals>): RiskSignals => ({
  v: 1,
  at: "2026-10-26T00:00:00Z",
  depositBlock: null,
  warnings: [],
  ...overrides,
});

const assess = (
  p: Partial<DeFiLlamaYieldPool>,
  extra: Partial<Parameters<ScoringService["assess"]>[0]> = {},
) =>
  s.assess({
    pool: pool(p),
    auditCount: 2,
    target: null,
    riskSignals: null,
    ...extra,
  });

describe("tier rules", () => {
  it("leaves a large, steady, single-asset audited pool conservative with no reasons", () => {
    expect(assess({})).toEqual({
      tier: "conservative",
      score: 84,
      reasons: [],
    });
  });

  it("makes an impermanent-loss LP aggressive whatever else is true", () => {
    const a = assess({ ilRisk: "yes", exposure: "multi" });
    expect(a.tier).toBe("aggressive");
    expect(a.reasons).toEqual(["impermanent_loss"]);
  });

  it.each([
    [{ apyMean30d: 30 }, "aggressive", "very_high_apy"],
    [{ apyMean30d: 13 }, "balanced", "high_apy"],
    [{ sigma: 1.5 }, "aggressive", "volatile_apy"],
    [{ sigma: 0.5 }, "balanced", "variable_apy"],
    [{ outlier: true }, "aggressive", "apy_outlier"],
    [{ tvlUsd: 600_000 }, "aggressive", "small_pool"],
    [{ tvlUsd: 6_000_000 }, "balanced", "modest_pool"],
    [{ exposure: "multi" as const }, "balanced", "multi_asset"],
  ])("%j -> %s (%s)", (overrides, tier, reason) => {
    const a = assess(overrides);
    expect(a.tier).toBe(tier);
    expect(a.reasons).toContain(reason);
  });

  it("reads 0 audits as unaudited, and an unknown count as nothing", () => {
    expect(assess({}, { auditCount: 0 }).reasons).toEqual(["unaudited"]);
    expect(assess({}, { auditCount: null }).tier).toBe("conservative");
  });

  it("separates a returned exploit from an unreturned one", () => {
    const returned = signals({
      exploit: { date: "2026-03-12", lostUsd: 862_000, returnedUsd: 862_000 },
      warnings: ["past_exploit"],
    });
    expect(assess({}, { riskSignals: returned })).toMatchObject({
      tier: "balanced",
      reasons: ["exploit_returned"],
    });
    const recent = signals({
      exploit: { date: "2026-10-25", lostUsd: 21_900, returnedUsd: 0 },
      depositBlock: "recent_exploit",
      warnings: ["recent_exploit"],
    });
    expect(assess({}, { riskSignals: recent }).tier).toBe("aggressive");
  });

  it("marks a queue exit and thin liquidity balanced", () => {
    const a = assess(
      {},
      {
        target: {
          kind: "lst-stake",
          venue: "lido",
          receipt: "0x1",
          asset: "0x0",
          exit: "queue",
        } as never,
        riskSignals: signals({ warnings: ["low_liquidity"] }),
      },
    );
    expect(a.tier).toBe("balanced");
    expect(a.reasons).toEqual(["low_liquidity", "exit_queue"]);
  });

  it("does not name any chain: the same pool scores the same everywhere", () => {
    expect(assess({ chain: "Monad" })).toEqual(assess({ chain: "Ethereum" }));
  });
});

describe("ordering score", () => {
  it("keeps every conservative pool above every balanced one", () => {
    const bestBalanced = assess({ exposure: "multi", apyMean30d: 11.9 }).score;
    const worstConservative = assess({ apyMean30d: 0.1 }).score;
    expect(worstConservative).toBeGreaterThan(bestBalanced);
  });

  it("ranks higher realistic yield first within a tier, capped", () => {
    expect(assess({ apyMean30d: 6 }).score).toBeGreaterThan(
      assess({ apyMean30d: 3 }).score,
    );
    expect(assess({ apyMean30d: 11 }).score).toBeLessThanOrEqual(99);
  });

  it("ranks on the 30-day mean, not a one-day spike", () => {
    expect(realisticApy(pool({ apy: 40, apyMean30d: 4 }))).toBe(4);
    expect(realisticApy(pool({ apy: 4, apyMean30d: undefined }))).toBe(4);
  });
});
