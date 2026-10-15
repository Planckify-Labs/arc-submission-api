import { declaredSlippageBps, shownFloor } from "./held-floor";

describe("shownFloor", () => {
  const base = { outRaw: 889051n, onChainMin: 887717n, defaultBps: 30 };

  it("is the provider's own minimum when nothing is held", () => {
    expect(shownFloor({ ...base, held: null })).toBe(887717n);
  });

  it("keeps the held floor while the on-chain minimum covers it", () => {
    expect(shownFloor({ ...base, held: 886384n })).toBe(886384n);
  });

  it("never reports above the on-chain minimum", () => {
    expect(shownFloor({ ...base, held: 887717n })).toBe(887717n);
    expect(shownFloor({ ...base, held: 887718n })).toBeLessThan(887717n);
  });

  it("falls back to the default-slippage floor when the held one is out of reach", () => {
    expect(shownFloor({ ...base, held: 888000n })).toBe(886383n);
  });
});

describe("declaredSlippageBps", () => {
  it("does not over-report by a basis point on a one-unit rise", () => {
    // Live 2026-10-15: 889155 against a floor of 886487 is 30 bps, not 31.
    expect(declaredSlippageBps(889155n, 886487n)).toBe(30);
  });

  it("stays at or under the floor in integer maths", () => {
    for (const [out, floor] of [
      [889051n, 886384n],
      [889155n, 886487n],
      [1_000_000n, 997_000n],
      [7n, 3n],
    ]) {
      const bps = declaredSlippageBps(out, floor);
      expect((out * BigInt(10_000 - bps)) / 10_000n).toBeLessThanOrEqual(floor);
      if (bps > 0) {
        expect((out * BigInt(10_000 - bps + 1)) / 10_000n).toBeGreaterThan(
          floor,
        );
      }
    }
  });

  it("rounds up so out × (1 − bps) stays at or under the floor", () => {
    const out = 889051n;
    const floor = 886384n;
    const bps = declaredSlippageBps(out, floor);
    expect(bps).toBe(30);
    expect((out * BigInt(10_000 - bps)) / 10_000n).toBeLessThanOrEqual(floor);
  });

  it("is zero for a floor at or above the output", () => {
    expect(declaredSlippageBps(100n, 100n)).toBe(0);
  });
});
