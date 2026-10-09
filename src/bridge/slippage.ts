/**
 * The slippage an adapter quotes with.
 *
 * Normally the route class default (`slippageBpsFor`), fixed server-side
 * and never user- or model-adjustable (bridge spec §8.4). One exception,
 * and it only ever TIGHTENS: the device's re-quote at signing carries the
 * minimum the user approved (`minReceiveRaw`). That minimum is the shown
 * quote's `expected × (1 − default)`, so re-quoting at the same default
 * clears it only if the expected output did not drop at all, and any tick
 * down refused a swap that was still above it (seen live on Arc testnet,
 * 2026-10-09). Quoting the signing pass at HALF the default lets the fresh
 * on-chain minimum land at or above the approved one for moves up to about
 * half the slippage, in a single provider round trip. The device still
 * refuses anything below the approved minimum, and larger moves get a
 * fresh quote.
 *
 * A second "re-quote tighter on a miss" pass was tried first and doubled
 * the latency: Tower alone takes 8 to 15 s per Arc quote (live-measured
 * 2026-10-09), so two passes ran past the app's 30 s request limit.
 */

/** Below this, ordinary block-to-block movement reverts the trade. */
export const MIN_HELD_SLIPPAGE_BPS = 5;

export function effectiveSlippageBps(
  defaultBps: number,
  req: { slippageBps?: number; minReceiveRaw?: string },
): number {
  if (req.slippageBps !== undefined) return req.slippageBps;
  if (!req.minReceiveRaw) return defaultBps;
  return Math.min(
    defaultBps,
    Math.max(MIN_HELD_SLIPPAGE_BPS, Math.floor(defaultBps / 2)),
  );
}
