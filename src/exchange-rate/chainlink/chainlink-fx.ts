/**
 * Pure checks and math for the Chainlink FX sync. No I/O here so every rule
 * that decides whether a payment price is published is unit-testable.
 */

import {
  CHAINLINK_FX_FEEDS,
  IDR_ASSET,
  type ChainlinkFxFeedPin,
} from "./chainlink-feeds";

/** Decimal places kept on rates written to `ExchangeRate.rate`. */
export const RATE_DECIMALS = 8;

export interface RawFeedRead {
  description: string;
  decimals: number;
  answer: bigint;
  updatedAtSec: bigint;
}

export interface FeedReading {
  key: string;
  asset: string;
  answer: bigint;
  decimals: number;
  updatedAtSec: number;
}

export type FeedCheck =
  | { ok: true; reading: FeedReading }
  | { ok: false; key: string; reason: string };

/**
 * One `ExchangeRate` pair to publish. `rate` = asset/USD, divided by
 * quoteAsset/USD when a quote asset is set (IDR).
 *
 * `region` must match what readers filter on: QRIS payments read
 * `<token>→IDR` in region `ID` (`IntentsService.snapshotLatestFx`).
 */
export interface FxPair {
  fromCurrency: string;
  toCurrency: string;
  region: string | null;
  asset: string;
  quoteAsset?: string;
}

export type PairRate =
  | { ok: true; rate: string; inputsUpdatedAtSec: number }
  | { ok: false; reason: string };

/** Slack past the heartbeat before a feed counts as stale. */
export function staleGraceSec(heartbeatSec: number): number {
  return Math.max(600, Math.floor(heartbeatSec / 10));
}

function scaledToNumber(answer: bigint, decimals: number): number {
  return Number(answer) / 10 ** decimals;
}

/**
 * Accept a raw read only if it is the feed we pinned, positive, fresh and
 * inside the pin's band. A failed check moves on to the asset's next feed;
 * if none pass, the pair is not written and the previous row keeps pricing.
 */
export function checkFeedRead(
  pin: ChainlinkFxFeedPin,
  raw: RawFeedRead,
  nowSec: number,
): FeedCheck {
  const fail = (reason: string): FeedCheck => ({
    ok: false,
    key: pin.key,
    reason,
  });

  if (raw.description !== pin.description) {
    return fail(
      `description "${raw.description}" != pinned "${pin.description}"`,
    );
  }
  if (raw.decimals !== pin.decimals) {
    return fail(`decimals ${raw.decimals} != pinned ${pin.decimals}`);
  }
  if (raw.answer <= 0n) return fail(`non-positive answer ${raw.answer}`);

  const updatedAtSec = Number(raw.updatedAtSec);
  if (!Number.isFinite(updatedAtSec) || updatedAtSec <= 0) {
    return fail("missing updatedAt");
  }
  if (updatedAtSec > nowSec + 300) {
    return fail(`updatedAt ${updatedAtSec} is in the future`);
  }
  const ageSec = nowSec - updatedAtSec;
  if (ageSec > pin.heartbeatSec + staleGraceSec(pin.heartbeatSec)) {
    return fail(`stale: ${ageSec}s old, heartbeat ${pin.heartbeatSec}s`);
  }
  if (pin.band) {
    const value = scaledToNumber(raw.answer, raw.decimals);
    if (value < pin.band.min || value > pin.band.max) {
      return fail(`${value} outside [${pin.band.min}, ${pin.band.max}]`);
    }
  }

  return {
    ok: true,
    reading: {
      key: pin.key,
      asset: pin.asset,
      answer: raw.answer,
      decimals: raw.decimals,
      updatedAtSec,
    },
  };
}

export interface TokenListing {
  symbol: string;
  isStablecoin: boolean;
}

/**
 * Which pairs to publish, from the live token list:
 *   - every listed symbol with a pinned feed gets `<symbol>→USD` history;
 *   - stablecoins also get `<symbol>→IDR` in region ID, the pair payments
 *     price from. Volatile tokens get no IDR row, so this never opens a new
 *     way to pay.
 * `fromCurrency` keeps the symbol exactly as stored, because readers match on
 * `Token.symbol`.
 */
export function derivePairs(
  tokens: readonly TokenListing[],
  feeds: readonly ChainlinkFxFeedPin[] = CHAINLINK_FX_FEEDS,
): FxPair[] {
  const priced = new Set(feeds.map((f) => f.asset));
  const bySymbol = new Map<string, boolean>();
  for (const t of tokens) {
    const symbol = t.symbol.trim();
    if (!symbol) continue;
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? false) || t.isStablecoin);
  }

  const pairs: FxPair[] = [];
  for (const [symbol, isStablecoin] of [...bySymbol].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const asset = symbol.toUpperCase();
    if (asset === IDR_ASSET || !priced.has(asset)) continue;
    pairs.push({
      fromCurrency: symbol,
      toCurrency: "USD",
      region: null,
      asset,
    });
    if (isStablecoin) {
      pairs.push({
        fromCurrency: symbol,
        toCurrency: "IDR",
        region: "ID",
        asset,
        quoteAsset: IDR_ASSET,
      });
    }
  }
  return pairs;
}

/** `value / 10^decimals` as a plain decimal string, trailing zeros trimmed. */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Compose a pair's rate in integer math so no answer loses precision through
 * floats. Rounds down: on `<token>→IDR` a lower rate means the payer sends
 * marginally more, never less.
 */
export function computePairRate(
  pair: FxPair,
  readings: ReadonlyMap<string, FeedReading>,
): PairRate {
  const num = readings.get(pair.asset);
  if (!num) return { ok: false, reason: `no valid feed for ${pair.asset}` };

  const scale = 10n ** BigInt(RATE_DECIMALS);

  if (!pair.quoteAsset) {
    const scaled = (num.answer * scale) / 10n ** BigInt(num.decimals);
    if (scaled <= 0n) return { ok: false, reason: "rate rounds to zero" };
    return {
      ok: true,
      rate: formatScaled(scaled, RATE_DECIMALS),
      inputsUpdatedAtSec: num.updatedAtSec,
    };
  }

  const den = readings.get(pair.quoteAsset);
  if (!den) {
    return { ok: false, reason: `no valid feed for ${pair.quoteAsset}` };
  }

  // (num / 10^numDec) / (den / 10^denDec), scaled by 10^RATE_DECIMALS.
  const scaled =
    (num.answer * 10n ** BigInt(den.decimals) * scale) /
    (den.answer * 10n ** BigInt(num.decimals));
  if (scaled <= 0n) return { ok: false, reason: "rate rounds to zero" };

  return {
    ok: true,
    rate: formatScaled(scaled, RATE_DECIMALS),
    inputsUpdatedAtSec: Math.max(num.updatedAtSec, den.updatedAtSec),
  };
}

/**
 * History holds one row per new Chainlink value, not one per poll. A row is
 * stamped with the time its reads started, so any round newer than the last
 * row's `createdAt` is a value we have not stored yet.
 */
export function hasNewRound(
  inputsUpdatedAtSec: number,
  lastRowCreatedAt: Date | null,
): boolean {
  if (!lastRowCreatedAt) return true;
  return inputsUpdatedAtSec * 1000 > lastRowCreatedAt.getTime();
}
