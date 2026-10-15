/**
 * The approved floor, held server-side across a swap's two quotes.
 *
 * A swap is quoted twice: once for the card the user approves, and again
 * by the device right before signing. The device refuses to sign when the
 * signing quote's `toAmountMinRaw` is below the card's. Both are
 * `expected × (1 − slippage)`, so at the same slippage ANY tick down in the
 * expected output fails the swap; Tower's Arc quotes jitter by a raw unit
 * or two between calls, so it failed most of the time.
 *
 * Devices from 5.26 send the card's floor as `minReceiveRaw` and the server
 * tightens slippage to hold it (`effectiveSlippageBps`). Earlier builds do
 * not send it, so the server remembers the floor it last showed for the
 * same wallet, pair and amount and uses that instead.
 *
 * With a held floor, the route is built at the tighter slippage, and the
 * REPORTED floor is the held one (raised to the default-slippage floor when
 * the price improved), never above the on-chain minimum. So the user is
 * still guaranteed at least the reported number, and a price move smaller
 * than the slippage headroom no longer reads as a stale quote. A larger
 * drop reports a fresh floor below the held one, and the device refuses as
 * before.
 */

import { Logger } from "@nestjs/common";
import type { ValkeyService } from "../valkey/valkey.service";

/** Long enough for a user to read the card and approve it. */
const HELD_FLOOR_TTL_SECONDS = 15 * 60;

/**
 * The floor to report for a fresh quote.
 *
 * `onChainMin` is what the built transaction enforces; the result is never
 * above it. Without a held floor that is the provider's own minimum.
 */
export function shownFloor(args: {
  outRaw: bigint;
  onChainMin: bigint;
  defaultBps: number;
  held: bigint | null;
}): bigint {
  const { outRaw, onChainMin, defaultBps, held } = args;
  if (held === null) return onChainMin;
  const atDefault = minBig(
    (outRaw * BigInt(10_000 - defaultBps)) / 10_000n,
    onChainMin,
  );
  if (onChainMin >= held) return held > atDefault ? held : atDefault;
  // The price fell past the headroom: report an honest fresh floor, which
  // the device refuses against the held one. Reporting the tight on-chain
  // minimum here would make it the next held floor, and the next quote at
  // the same tight slippage would miss it on any tick down.
  return atDefault;
}

/**
 * The smallest slippage the reported floor satisfies against the expected
 * output: `⌊out × (10000 − bps) / 10000⌋ ≤ floor`, the device's check in
 * integer maths (a plain ceiling over-reports by a basis point).
 */
export function declaredSlippageBps(outRaw: bigint, floor: bigint): number {
  if (outRaw <= 0n || floor >= outRaw) return 0;
  const keep = ((floor + 1n) * 10_000n - 1n) / outRaw;
  return Math.max(0, Number(10_000n - keep));
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Valkey-backed so the card quote and the signing quote agree whichever
 * replica serves them. Any cache failure degrades to "no held floor", which
 * is the old behaviour, never to a failed quote.
 */
export class HeldFloorStore {
  private readonly logger = new Logger(HeldFloorStore.name);

  constructor(
    private readonly valkey: ValkeyService | undefined,
    private readonly namespace: string,
  ) {}

  key(parts: {
    chainId: number;
    wallet: string;
    inputToken: string;
    outputToken: string;
    amountRaw: string;
  }): string {
    return [
      "bridge",
      this.namespace,
      "floor",
      parts.chainId,
      parts.wallet.toLowerCase(),
      parts.inputToken.toLowerCase(),
      parts.outputToken.toLowerCase(),
      parts.amountRaw,
    ].join(":");
  }

  async get(key: string): Promise<bigint | null> {
    if (!this.valkey) return null;
    try {
      // Stored as an object: a bare digit string would come back from the
      // service's JSON.parse as a lossy number.
      const row = await this.valkey.get<{ floor?: unknown }>(key);
      return typeof row?.floor === "string" && /^[0-9]+$/.test(row.floor)
        ? BigInt(row.floor)
        : null;
    } catch (error: unknown) {
      this.logger.warn(`[get] held floor unavailable: ${describe(error)}`);
      return null;
    }
  }

  async set(key: string, floor: bigint): Promise<void> {
    if (!this.valkey) return;
    try {
      await this.valkey.set(
        key,
        { floor: floor.toString() },
        { ttl: HELD_FLOOR_TTL_SECONDS },
      );
    } catch (error: unknown) {
      this.logger.warn(`[set] held floor not saved: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
