# Swap floor held across quote and signing

Status: server-only fix shipped 2026-10-15 (`src/bridge/held-floor.ts`). This
note records why, and what a cleaner fix across the server and the app looks like.

## What broke

Tower swaps on Arc mainnet (USDC → EURC, app v5.25.0, prod) failed nearly every
time with `quote_stale`. The agent relays that as "the price moved, getting a fresh
quote", and users read it as "the quote expired". The quote never expired: Tower
quotes live for 120 s and the swap calldata has a 20 min deadline.

The device quotes a swap twice:

1. `swap_quote`: the card the user approves, showing `toAmountMinRaw` (the floor).
2. `swap_execute`: re-quotes right before signing, and refuses to sign if the fresh
   `toAmountMinRaw` is below the card's floor.

Both floors were `expected × (1 − 30 bps)`. The expected output moves by a raw unit
or two between calls, on Tower (live: 889052 → 889051) and on LI.FI alike, so any
downward tick put the signing floor one unit under the card's, and the swap was
refused.

App 5.26.0 sends the card's floor as `minReceiveRaw` on the signing re-quote, and
the server tightens slippage to hold it (`effectiveSlippageBps`). App 5.25.x does
not send it, so the server never tightened.

## Server-only fix (current)

`BridgeService.quote` holds the floor for every same-chain swap, whichever provider
serves it (Tower, or LI.FI when Tower declines or is not configured). It remembers
the floor it last reported for `(chain, wallet, fromAsset, toAsset, amount)` in
Valkey (15 min TTL). When it has a floor, from `minReceiveRaw` or from Valkey, it:

- passes it to the adapter as `minReceiveRaw`, so the route is built at the tighter
  slippage (15 bps for stable pairs), and
- reports the held floor as `toAmountMinRaw`, raised to the default-slippage floor
  if the price improved, and never above the on-chain minimum.

`slippageBps` is set to the smallest value the reported floor satisfies, so the
device's `RouteSlippageFloorCheck` passes. If the price drops more than the
headroom (about 15 bps), the server reports an honest lower floor and the device
refuses the swap as before. Any Valkey failure falls back to the old behaviour.

Every swap quote logs one line with the numbers that decide whether the device
accepts it:

```
[quote] swap floor via tower (<from> -> <to>): out 889120, on-chain min 887786, held 886454 (remembered), reported 886454
```

`held none` on a signing quote means the card quote was not remembered (Valkey
down, or a different wallet, pair or amount).

Limits of the fix:

- The quote is matched by wallet, pair and amount, not by identity. Two cards for
  the same swap within 15 minutes share one floor. That is harmless, but it is a
  guess.
- A drop larger than the headroom still fails, as it should. Tower is usually
  stable to a fraction of a basis point, but one live sample jumped 54 bps between
  two calls when its route changed.

## Better fix (both sides, later)

1. **Bind the re-quote to the approved quote.** Return an opaque, signed
   `floorToken` (or the `quoteId`) with the card quote. The device sends it back on
   the signing re-quote. The server reads the approved floor from that token
   instead of a Valkey lookup keyed by wallet, pair and amount.
2. **Mark the signing re-quote explicitly** (`purpose: "execute"`). The server then
   knows which quote to tighten without inferring it from a missing or present
   `minReceiveRaw`.
3. **Split `quote_stale` on the device** into `quote_expired` (TTL) and
   `floor_not_met` (price moved below the approved minimum), with separate copy.
   Report the sub-reason to the server or analytics: this failure was invisible in
   server logs and only surfaced through the agent's paraphrase.
4. **Once 5.25.x usage is gone,** the Valkey fallback can be removed and the floor
   taken only from the request (or from the token in item 1).
