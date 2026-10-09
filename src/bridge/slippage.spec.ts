import { effectiveSlippageBps, MIN_HELD_SLIPPAGE_BPS } from "./slippage";

describe("effectiveSlippageBps", () => {
  it("is the route default for an ordinary quote", () => {
    expect(effectiveSlippageBps(30, {})).toBe(30);
  });

  it("halves the default when holding an approved floor", () => {
    expect(effectiveSlippageBps(30, { minReceiveRaw: "2131803" })).toBe(15);
    expect(effectiveSlippageBps(100, { minReceiveRaw: "1" })).toBe(50);
  });

  it("never goes below the revert-safety minimum, nor above the default", () => {
    expect(effectiveSlippageBps(6, { minReceiveRaw: "1" })).toBe(MIN_HELD_SLIPPAGE_BPS);
    expect(effectiveSlippageBps(3, { minReceiveRaw: "1" })).toBe(3);
  });

  it("an internal pin still wins (gas top-up composer)", () => {
    expect(effectiveSlippageBps(30, { slippageBps: 50, minReceiveRaw: "1" })).toBe(50);
  });

  it("the arithmetic: half the slippage absorbs a drop up to about half of it", () => {
    // Shown: expected 2_138_218 at 30 bps → approved min 2_131_803.
    const approved = 2_131_803n;
    // Expected fell 0.07% (the live case). At 30 bps the fresh min misses;
    // at the held 15 bps it clears.
    const fresh = 2_136_770n;
    const at = (bps: number) => (fresh * BigInt(10_000 - bps)) / 10_000n;
    expect(at(30) < approved).toBe(true);
    expect(at(effectiveSlippageBps(30, { minReceiveRaw: "x" })) >= approved).toBe(true);
  });
});
