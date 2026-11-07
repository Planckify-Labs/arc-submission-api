import { computePointsApplied, MIN_TOKEN_REMAINDER_USD } from "./points-allocation";

describe("computePointsApplied", () => {
  const rate = 15700; // IDR per token; minimum remainder = ceil(0.3 x 15700) = 4710

  it("the minimum remainder is a single 0.30 USD constant", () => {
    expect(MIN_TOKEN_REMAINDER_USD).toBe(0.3);
  });

  it("a partial balance is applied in full", () => {
    expect(computePointsApplied({ sellPrice: "100000", rate, balance: 30000n })).toBe(
      30000n,
    );
  });

  it("a balance covering the price is capped so the minimum stays in tokens", () => {
    expect(
      computePointsApplied({ sellPrice: "100000", rate, balance: 500000n }),
    ).toBe(95290n);
  });

  it("rounds the price and the remainder UP", () => {
    // fullPoints = ceil(100000.2) = 100001; minRemainder = ceil(0.3 x 15701) = 4711
    expect(
      computePointsApplied({ sellPrice: "100000.2", rate: 15701, balance: 10n ** 9n }),
    ).toBe(95290n);
  });

  it("a price at or below the minimum remainder applies nothing", () => {
    expect(computePointsApplied({ sellPrice: "4710", rate, balance: 99999n })).toBe(0n);
    expect(computePointsApplied({ sellPrice: "4000", rate, balance: 99999n })).toBe(0n);
  });

  it("an empty balance applies nothing", () => {
    expect(computePointsApplied({ sellPrice: "100000", rate, balance: 0n })).toBe(0n);
  });

  it("never applies more than the balance or leaves less than the minimum", () => {
    for (const balance of [1n, 4709n, 95289n, 95290n, 95291n, 10n ** 12n]) {
      const applied = computePointsApplied({ sellPrice: "100000", rate, balance });
      expect(applied <= balance).toBe(true);
      expect(100000n - applied >= 4710n).toBe(true);
    }
  });
});
