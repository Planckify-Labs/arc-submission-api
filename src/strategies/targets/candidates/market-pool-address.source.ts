/**
 * Candidate addresses from our market API (`market.takumipay.xyz`), the free
 * replacement for DeFiLlama's paid `/poolsOld`.
 *
 * The market API runs each protocol's open-source yield adapter itself, which
 * keys every pool by `"<address>-<chain>"`, and joins that with DeFiLlama's
 * free `/pools` UUIDs (`GET /api/pool-addresses/:protocol`):
 *
 *   - `uuidv5`: DeFiLlama mints a new pool's id as UUIDv5 of the adapter's pool
 *     key, so hashing the key reproduces the id. An identity, not a guess.
 *   - `attributes`: older (v4) ids, matched on chain + underlying + symbol +
 *     poolMeta only when exactly one pool has them and the TVLs agree.
 *     Siblings that share all four get no address at all.
 *
 * It sits where `/poolsOld` sat: a `"*"` fallback, after every source that
 * asks the protocol itself. And like every source it is a CANDIDATE — the
 * resolver's validator proves it on-chain, and for vault kinds a second
 * source that names a different contract refuses the pool
 * (`independentSourcesAgree`).
 *
 * Config, not code: `MARKET_API_URL` + `MARKET_API_KEY`. Without both the
 * source is not registered (bootstrap.ts), so it can never sit in the chain
 * looking like coverage while answering nothing.
 */

import type { DeFiLlamaYieldPool } from "../../external/defillama.client";
import type { Address, ResolverContext } from "../types";
import type { CandidateSource } from "./registry";

interface PoolAddressesResponse {
  status?: string;
  ownRun?: { ageSeconds?: number };
  entries?: Array<{
    pool?: string;
    chain?: string;
    address?: string;
    method?: string;
  }>;
}

/** Per-protocol answer cache. The market API refreshes its runs daily. */
const CACHE_TTL_SEC = 30 * 60;

/**
 * Oldest own adapter run we take addresses from. Addresses barely move, and
 * the validator re-proves each one, but a run this stale says the market API
 * stopped refreshing, and that is a reason to stop leaning on it.
 */
const DEFAULT_MAX_RUN_AGE_HOURS = 72;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRUSTED_METHODS = new Set(["uuidv5", "attributes"]);

export function marketApiConfig(): { url: string; key: string } | null {
  const url = process.env.MARKET_API_URL?.trim().replace(/\/+$/, "");
  const key = process.env.MARKET_API_KEY?.trim();
  return url && key ? { url, key } : null;
}

function maxRunAgeSeconds(): number {
  const hours = Number(process.env.MARKET_POOL_ADDRESS_MAX_AGE_HOURS);
  return (
    (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_RUN_AGE_HOURS) *
    3600
  );
}

export async function marketPoolAddressCandidate(
  pool: DeFiLlamaYieldPool,
  ctx: ResolverContext,
): Promise<Address | null> {
  const config = marketApiConfig();
  if (!config || !pool.pool || !pool.project) return null;

  const res = await ctx.fetchJsonCached<PoolAddressesResponse>(
    `market:pool-addresses:${pool.project}:v1`,
    `${config.url}/api/pool-addresses/${encodeURIComponent(pool.project)}`,
    CACHE_TTL_SEC,
    {
      headers: { Accept: "application/json", "X-API-Key": config.key },
      // A 202 "pending" (first run still going) must not be remembered as
      // "this protocol has no pools" for the whole TTL.
      cacheIf: (body) => body?.status === "success",
    },
  );
  if (res?.status !== "success") return null;
  const age = res.ownRun?.ageSeconds;
  if (typeof age !== "number" || age > maxRunAgeSeconds()) return null;

  const entry = res.entries?.find((e) => e.pool === pool.pool);
  if (!entry?.address || !ADDRESS.test(entry.address)) return null;
  if (!entry.method || !TRUSTED_METHODS.has(entry.method)) return null;
  // The entry must be about the pool we asked for.
  if (entry.chain && pool.chain && entry.chain !== pool.chain) return null;

  const address = entry.address.toLowerCase() as Address;
  // The deposited token itself is never the vault.
  const underlying = pool.underlyingTokens?.[0]?.toLowerCase();
  if (underlying && underlying === address) return null;
  return address;
}

export const MarketPoolAddressSource: CandidateSource = {
  id: "market-pool-addresses",
  projects: "*",
  corroborates: true,
  candidate: (pool, ctx) => marketPoolAddressCandidate(pool, ctx),
};
