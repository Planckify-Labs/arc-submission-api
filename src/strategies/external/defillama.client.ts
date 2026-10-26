import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ValkeyService } from "../../valkey/valkey.service";
import {
  type ChainDirectoryRow,
  chainDirectorySize,
  findChainByName,
} from "../targets/chain-directory";

export interface DeFiLlamaYieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apy7d?: number;
  apyBase?: number;
  apyReward?: number;
  ilRisk: "yes" | "no";
  exposure: "multi" | "stable" | "single";
  // Pool-level deposits (spec §3, §4.2): the only address-bearing +
  // disambiguation fields in `/pools`. Previously dropped in filterPools;
  // now carried so the resolver registry can turn (project, chain,
  // underlyingTokens, poolMeta) into an on-chain deposit target.
  /** Vault/market name or fee tier ("Steakhouse USDC", "0.05%"). Free-text
   *  label, NOT an address. Primary disambiguator between sibling pools. */
  poolMeta?: string | null;
  /** Underlying **asset** contract(s) the user deposits (ERC-20 / SPL mint /
   *  Sui coin type). Never the vault/market. Matching key + fills assetContract. */
  underlyingTokens?: string[];
}

interface DeFiLlamaPoolsResponse {
  status: string;
  data: Array<{
    pool: string;
    chain: string;
    project: string;
    symbol: string;
    tvlUsd: number;
    apy: number | null;
    apyMean30d?: number | null;
    apyBase?: number | null;
    apyReward?: number | null;
    ilRisk: "yes" | "no";
    exposure: "multi" | "stable" | "single";
    stablecoin?: boolean;
    apyPct7D?: number | null;
    poolMeta?: string | null;
    underlyingTokens?: string[] | null;
  }>;
}

export interface ProtocolMetadata {
  slug: string;
  name: string;
  auditCount: number;
  gecko_id: string | null;
  category: string | null;
  chains: string[];
  /** Protocol's own app URL — manual deep-link homepage fallback (spec §9.1). */
  appUrl: string | null;
  /**
   * True when this is a PLACEHOLDER because the lookup failed, not a real
   * answer. Callers must not treat degraded fields as facts: `auditCount: 0`
   * here means "we could not ask", which is a completely different claim from
   * "this protocol has no audits" — and the scorer charges 45 points of
   * `protocolSafety` for the difference (85 → 40), enough to move a pool's
   * tier and drop it out of the user's filtered list entirely.
   */
  degraded: boolean;
}

/**
 * How long a FAILED protocol lookup is remembered before it is retried.
 *
 * Sized against the POLL CADENCE, not against how fast an endpoint might
 * recover. A scoring tick takes minutes to drain ~338 pools at concurrency 8,
 * and a failing lookup costs a worker slot the full connect timeout (10s) every
 * time it is attempted. At 60s a single bad slug is retried ~30 times per tick
 * and burns ~5 minutes of scoring throughput on its own; at 10 minutes it is
 * retried about three times, and the tick after that starts clean.
 *
 * Recovery is not actually delayed by this: metadata is `auditCount`/`category`
 * feeding the SCORE, and it never gates `depositTarget`. A pool with degraded
 * metadata still resolves its deposit target and still badges in-app.
 */
const PROTOCOL_FAILURE_TTL_MS = 10 * 60_000;

interface DeFiLlamaProtocol {
  id?: string;
  name?: string;
  slug?: string;
  audits?: string | number | null;
  audit_note?: string | null;
  gecko_id?: string | null;
  category?: string | null;
  chains?: string[];
  tvl?: number;
  // Protocol's own app URL — the manual deep-link homepage fallback
  // (spec §9.1). Already returned by /protocol/{slug}; previously dropped.
  url?: string | null;
}

// v4: per-chain TVL floor + per-chain top-N cap (50) + round-robin fair
// selection under a 300 ceiling, plus "SUI" in the symbol set. Bumped so the
// new selection takes effect on next poll instead of serving the stale set.
// v5: additionally capture `poolMeta` + `underlyingTokens` (pool-level
// deposits spec §3/§4.2 — the resolver's matching keys). Bumped so the new
// fields are populated on the next poll instead of serving the v4 shape that
// dropped them.
// v6: chains come from the chain directory instead of a literal list, and
// each chain's own Token-row symbols are admitted. Bumped so Monad/Stellar
// pools arrive on the next poll instead of after the v5 set expires.
const POOLS_CACHE_KEY = "defillama:pools:filtered:v6";
const DEFAULT_POOLS_CACHE_TTL_SEC = 30 * 60; // 30 min — matches the cron tick
const DEFAULT_PROTOCOL_CACHE_TTL_SEC = 6 * 60 * 60; // 6 h — slow-moving metadata
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_TVL_USD = 5_000_000;
// Overall ceiling on cached pools. Sized so the per-chain cap below is the
// real limiter (sum across chains stays under it) and no chain gets trimmed.
const DEFAULT_MAX_POOLS = 300;
// Per-chain cap. Keeps each chain's top-N by TVL. Set high enough that
// smaller-TVL venues on a chain still make the cut — e.g. Scallop's USDC pool
// on Sui (~$660K) ranks ~36th among Sui pools, so a cap of 50 keeps it.
const DEFAULT_MAX_POOLS_PER_CHAIN = 50;
// Non-EVM chains (Sui, Solana) run at structurally smaller TVL than the
// Ethereum L1/L2 set, so a single $5M floor erases them entirely. They get
// their own lower floor; EVM keeps DEFAULT_MIN_TVL_USD. Keyed by chain, not
// protocol — no venue is special-cased.
const DEFAULT_MIN_TVL_USD_NON_EVM = 250_000;

// There is deliberately NO chain list here. Which chains we score is the
// chain directory (active mainnet `Blockchain` rows, see chain-directory.ts),
// the same snapshot the scorer maps `pool.chain` through. A literal list used
// to sit here and silently overrode the table: Monad and Stellar had rows, an
// app surface and real DeFiLlama pools (71 over $1M on Monad), yet the agent
// answered "no options" on both because their pools were dropped before the
// data-driven half of the pipeline ever saw them. It also admitted Optimism,
// which has no row, so its pools were scored as `eip155` chainId 0.

// Symbols we score on every chain, ON TOP OF each chain's own listed assets
// (its `Token` rows, see `chainAssetTokens`). DeFiLlama uses things like
// "USDC", "STETH", "USDC-USDT" for LP pools; substring match keeps multi-asset
// pools in.
const RELEVANT_SYMBOL_TOKENS = [
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "PYUSD",
  "ETH",
  "WETH",
  "STETH",
  "WSTETH",
  "RETH",
  "CBETH",
  "SOL",
  "JITOSOL",
  "MSOL",
  "BNSOL",
  "BTC",
  "WBTC",
  "TBTC",
  // Native SUI (and SUI-LST variants: haSUI/vSUI/afSUI) — surfaces Sui
  // staking/lending pools, e.g. Scallop's $2M SUI supply pool. Substring
  // match adds no non-Sui-chain pools (verified against the live feed).
  "SUI",
];

/**
 * Shortest token-table symbol used as a substring match. The match has to be a
 * substring (DeFiLlama names vaults "SYRUPUSDC", "EARNAUSD"), and at one or two
 * characters that matches nearly everything: a chain whose native token is "S"
 * would admit every pool on it.
 */
const MIN_ASSET_SYMBOL_LENGTH = 3;

/** The chain's own listed assets, as substring tokens for `filterPools`. */
function chainAssetTokens(row: ChainDirectoryRow): string[] {
  return (row.assetSymbols ?? [])
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length >= MIN_ASSET_SYMBOL_LENGTH);
}

/** A chain we have an active mainnet row for — the only pools we score. */
function isDirectoryMainnet(chain: string | undefined): boolean {
  const row = findChainByName(chain);
  return !!row && !row.isTestnet;
}

function toYieldPool(
  p: DeFiLlamaPoolsResponse["data"][number],
): DeFiLlamaYieldPool {
  return {
    pool: p.pool,
    chain: p.chain,
    project: p.project,
    symbol: p.symbol,
    tvlUsd: p.tvlUsd,
    apy: p.apy as number,
    apy7d:
      (typeof p.apyPct7D === "number"
        ? (p.apy as number) + p.apyPct7D
        : undefined) ??
      p.apyMean30d ??
      undefined,
    apyBase: p.apyBase ?? undefined,
    apyReward: p.apyReward ?? undefined,
    ilRisk: p.ilRisk ?? "no",
    exposure: p.exposure ?? "single",
    // Pool-level deposits (spec §3): carry the resolver's matching keys.
    poolMeta: p.poolMeta ?? null,
    underlyingTokens: Array.isArray(p.underlyingTokens)
      ? p.underlyingTokens
      : undefined,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Node's undici-backed `fetch` wraps every transport-level failure in a
 * generic `TypeError: fetch failed` and stashes the real reason on
 * `error.cause` (e.g. `Error { code: 'ENOTFOUND' }` for DNS,
 * `'ECONNREFUSED'`, `'UND_ERR_CONNECT_TIMEOUT'`, etc.). The wrapper's
 * message alone is useless for triage — this walks the cause chain and
 * returns a single human string like `fetch failed: ENOTFOUND
 * yields.llama.fi (getaddrinfo)` that's safe to log.
 *
 * Also normalises `AbortError` (our 20s timeout) into a clearer label.
 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "AbortError") return "request aborted (timeout)";

  const parts: string[] = [err.message || err.name];
  let cause: unknown = (err as { cause?: unknown }).cause;
  // Walk the cause chain (undici sometimes nests 2 deep: TypeError → Error → SystemError).
  while (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    const syscall = (cause as NodeJS.ErrnoException).syscall;
    const hostname = (cause as { hostname?: string }).hostname;
    const tag = [code, hostname, syscall].filter(Boolean).join(" ");
    parts.push(tag ? `${cause.message} (${tag})` : cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" → ");
}

function requireUrl(configService: ConfigService, name: string): string {
  const value = configService.get<string>(name);
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is required (DeFi Strategies). Set it in your environment — see .env.example for the production default.`,
    );
  }
  return stripTrailingSlash(value.trim());
}

@Injectable()
export class DeFiLlamaClient {
  private readonly logger = new Logger(DeFiLlamaClient.name);
  private readonly apiKey: string;
  private readonly yieldsBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly proBaseUrl: string;
  private readonly poolsCacheTtlSec: number;
  private readonly protocolCacheTtlSec: number;
  private readonly requestTimeoutMs: number;
  private readonly minTvlUsd: number;
  private readonly minTvlUsdNonEvm: number;
  private readonly maxPools: number;
  private readonly maxPoolsPerChain: number;
  /** The whole `/pools` feed from the last network fetch, for `feedPool`. */
  private fullFeed: {
    at: number;
    byId: Map<string, DeFiLlamaYieldPool>;
  } | null = null;
  /**
   * One in-flight request per protocol slug.
   *
   * `getProtocolMetadata` is called ONCE PER POOL, but the answer is
   * protocol-scoped — ~338 pools a tick share ~50 slugs. On a cache hit that is
   * harmless. On a cache MISS at concurrency 8 it is eight simultaneous
   * requests for the same slug, and on a cache miss that keeps failing it is
   * every pool re-asking, every tick, forever: nothing is stored when the fetch
   * fails, so the next pool starts from scratch.
   *
   * That is the "logs never stop" symptom, and it is self-reinforcing — the
   * storm is exactly what earns a rate limit from the endpoint that is already
   * struggling.
   */
  private readonly inflightProtocol = new Map<
    string,
    Promise<ProtocolMetadata>
  >();
  /**
   * Slug → when it may be retried. A FAILED lookup is remembered too, briefly.
   *
   * Caching only successes means a failure costs one request per pool instead
   * of one request per protocol. Sixty seconds is short enough that a recovered
   * endpoint is picked up within the same tick, and long enough that a broken
   * one is asked once rather than hundreds of times.
   */
  private readonly protocolRetryAfter = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly valkeyService: ValkeyService,
  ) {
    this.apiKey = this.configService.get<string>("DEFILLAMA_API_KEY") || "";
    this.yieldsBaseUrl = requireUrl(this.configService, "DEFILLAMA_YIELDS_URL");
    this.apiBaseUrl = requireUrl(this.configService, "DEFILLAMA_API_URL");
    // Pro endpoint is only used when a key is present — only require it then.
    this.proBaseUrl = this.apiKey
      ? requireUrl(this.configService, "DEFILLAMA_PRO_URL")
      : "";
    this.poolsCacheTtlSec = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_POOLS_CACHE_TTL_SEC"),
      DEFAULT_POOLS_CACHE_TTL_SEC,
    );
    this.protocolCacheTtlSec = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_PROTOCOL_CACHE_TTL_SEC"),
      DEFAULT_PROTOCOL_CACHE_TTL_SEC,
    );
    this.requestTimeoutMs = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_REQUEST_TIMEOUT_MS"),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.minTvlUsd = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_MIN_TVL_USD"),
      DEFAULT_MIN_TVL_USD,
    );
    this.minTvlUsdNonEvm = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_MIN_TVL_USD_NON_EVM"),
      DEFAULT_MIN_TVL_USD_NON_EVM,
    );
    this.maxPools = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_MAX_POOLS"),
      DEFAULT_MAX_POOLS,
    );
    this.maxPoolsPerChain = positiveIntFromEnv(
      this.configService.get<string>("DEFILLAMA_MAX_POOLS_PER_CHAIN"),
      DEFAULT_MAX_POOLS_PER_CHAIN,
    );
    if (!this.apiKey) {
      this.logger.log(
        "DEFILLAMA_API_KEY not set — using public /pools endpoint (rate-limited, sufficient for 30-min cron).",
      );
    }
  }

  async getYieldPools(): Promise<DeFiLlamaYieldPool[]> {
    const started = Date.now();
    const cached = await this.valkeyService
      .get<string>(POOLS_CACHE_KEY)
      .catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as DeFiLlamaYieldPool[];
        this.logger.log(
          `[getYieldPools] <- valkey cache hit (${parsed.length} pools)`,
        );
        return parsed;
      } catch {
        // fall through to network
      }
    }

    // Every pool is kept or dropped by its chain-directory row. Filtering
    // against an unloaded directory would drop all of them and then cache that
    // empty set for a full TTL, so fail the tick instead; BullMQ retries it.
    if (chainDirectorySize() === 0) {
      throw new Error("Chain directory not loaded; skipping DeFiLlama poll");
    }

    this.logger.log(
      `[getYieldPools] -> DeFiLlama /pools (hasKey=${Boolean(this.apiKey)})`,
    );

    try {
      const url = this.apiKey
        ? `${this.proBaseUrl}/${this.apiKey}/yields/pools`
        : `${this.yieldsBaseUrl}/pools`;
      const raw = await this.fetchJson<DeFiLlamaPoolsResponse>(url);
      if (!raw || raw.status !== "success" || !Array.isArray(raw.data)) {
        throw new Error(`Unexpected response shape (status=${raw?.status})`);
      }

      this.fullFeed = {
        at: Date.now(),
        byId: new Map(
          raw.data
            .filter((p) => p?.pool && isDirectoryMainnet(p.chain))
            .map((p) => [p.pool, toYieldPool(p)]),
        ),
      };
      const filtered = this.filterPools(raw.data);
      this.logger.log(
        `[getYieldPools] <- DeFiLlama returned ${raw.data.length} pools (kept ${filtered.length}) in ${Date.now() - started}ms`,
      );

      await this.valkeyService
        .set(POOLS_CACHE_KEY, JSON.stringify(filtered), {
          ttl: this.poolsCacheTtlSec,
        })
        .catch((err) => {
          this.logger.warn(
            `[getYieldPools] valkey cache set failed: ${err?.message ?? err}`,
          );
        });

      return filtered;
    } catch (error: unknown) {
      this.logger.error(
        `[getYieldPools] DeFiLlama request failed (url=${
          this.apiKey
            ? `${this.proBaseUrl}/<key>/yields/pools`
            : `${this.yieldsBaseUrl}/pools`
        }): ${describeFetchError(error)}`,
      );
      // Re-throw — the poll processor's catch block already handles this and
      // BullMQ will retry. Returning stub data would silently mask outages.
      throw error;
    }
  }

  async getProtocolMetadata(slug: string): Promise<ProtocolMetadata> {
    // v2: shape gains `appUrl` (spec §9.1). Bumped so cached v1 entries are
    // re-fetched instead of served without the new field.
    const cacheKey = `defillama:protocol:${slug}:v2`;
    const cached = await this.valkeyService
      .get<string>(cacheKey)
      .catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as ProtocolMetadata;
      } catch {
        // fall through
      }
    }

    // Recently failed: serve degraded WITHOUT asking again. Every pool sharing
    // this slug would otherwise repeat the same failing request.
    const retryAfter = this.protocolRetryAfter.get(slug);
    if (retryAfter !== undefined && Date.now() < retryAfter) {
      return this.degradedProtocolMetadata(slug);
    }

    // Already being fetched by another pool in this tick — join it.
    const existing = this.inflightProtocol.get(slug);
    if (existing) return existing;

    const task = this.fetchProtocolMetadata(slug, cacheKey).finally(() => {
      this.inflightProtocol.delete(slug);
    });
    this.inflightProtocol.set(slug, task);
    return task;
  }

  private degradedProtocolMetadata(slug: string): ProtocolMetadata {
    return {
      degraded: true,
      slug,
      name: this.titleCase(slug),
      auditCount: 0,
      gecko_id: null,
      category: null,
      chains: [],
      appUrl: null,
    };
  }

  private async fetchProtocolMetadata(
    slug: string,
    cacheKey: string,
  ): Promise<ProtocolMetadata> {
    this.logger.log(`[getProtocolMetadata] -> DeFiLlama slug=${slug}`);
    try {
      const data = await this.fetchJson<DeFiLlamaProtocol>(
        `${this.apiBaseUrl}/protocol/${encodeURIComponent(slug)}`,
      );
      const normalised: ProtocolMetadata = {
        degraded: false,
        slug,
        name: data?.name ?? this.titleCase(slug),
        auditCount: this.parseAuditCount(data?.audits),
        gecko_id: data?.gecko_id ?? null,
        category: data?.category ?? null,
        chains: Array.isArray(data?.chains) ? data.chains : [],
        appUrl:
          typeof data?.url === "string" && data.url.trim()
            ? data.url.trim()
            : null,
      };
      this.protocolRetryAfter.delete(slug);
      await this.valkeyService
        .set(cacheKey, JSON.stringify(normalised), {
          ttl: this.protocolCacheTtlSec,
        })
        .catch(() => undefined);
      return normalised;
    } catch (error: unknown) {
      this.protocolRetryAfter.set(slug, Date.now() + PROTOCOL_FAILURE_TTL_MS);
      this.logger.warn(
        `[getProtocolMetadata] DeFiLlama failed for slug=${slug} (url=${this.apiBaseUrl}/protocol/${encodeURIComponent(slug)}): ${describeFetchError(error)} — using degraded metadata, not retrying this slug for ${PROTOCOL_FAILURE_TTL_MS / 60_000}min`,
      );
      return this.degradedProtocolMetadata(slug);
    }
  }

  /** Per-chain TVL floor: non-EVM chains get the lower threshold. */
  private minTvlForChain(row: ChainDirectoryRow): number {
    return row.family === "EVM" ? this.minTvlUsd : this.minTvlUsdNonEvm;
  }

  private filterPools(
    pools: DeFiLlamaPoolsResponse["data"],
  ): DeFiLlamaYieldPool[] {
    const seen = new Set<string>();
    const eligible = pools.filter((p) => {
      if (!p.pool || seen.has(p.pool)) return false;
      // DeFiLlama only lists mainnets; a testnet row must never claim a pool.
      const row = findChainByName(p.chain);
      if (!row || row.isTestnet) return false;
      // Per-chain floor — a single Ethereum-scale threshold erases Sui/Solana.
      if (typeof p.tvlUsd !== "number" || p.tvlUsd < this.minTvlForChain(row))
        return false;
      if (typeof p.apy !== "number" || p.apy <= 0) return false;
      const symbolUpper = (p.symbol ?? "").toUpperCase();
      const isRelevantSymbol = [
        ...RELEVANT_SYMBOL_TOKENS,
        ...chainAssetTokens(row),
      ].some((token) => symbolUpper.includes(token));
      if (!isRelevantSymbol) return false;
      seen.add(p.pool);
      return true;
    });

    // Fair selection across chains. A plain global TVL sort + slice(maxPools)
    // let the hundreds of high-TVL Ethereum pools crowd out every Sui/Solana
    // pool (Sui ranked 173+ globally → 0 cached). Instead group by chain,
    // sort each by TVL, then round-robin highest-first across chains up to
    // the same overall ceiling — so every chain is represented. Chain-keyed,
    // never protocol-keyed: new chains/venues are picked up automatically.
    const byChain = new Map<string, DeFiLlamaPoolsResponse["data"]>();
    for (const p of eligible) {
      const chain = (p.chain ?? "").toLowerCase();
      const list = byChain.get(chain) ?? [];
      list.push(p);
      byChain.set(chain, list);
    }
    for (const [chain, list] of byChain) {
      list.sort((a, b) => b.tvlUsd - a.tvlUsd);
      // Cap each chain to its top-N so one chain can't dominate the cache,
      // and so smaller-TVL venues within a chain (e.g. Scallop USDC on Sui,
      // ~36th by Sui TVL) still make the cut.
      if (list.length > this.maxPoolsPerChain) {
        byChain.set(chain, list.slice(0, this.maxPoolsPerChain));
      }
    }
    // Lead each round with the strongest chains (by their top pool's TVL) so
    // ordering is deterministic and EVM still fills first within its slots.
    const chains = [...byChain.keys()].sort(
      (a, b) =>
        (byChain.get(b)?.[0]?.tvlUsd ?? 0) - (byChain.get(a)?.[0]?.tvlUsd ?? 0),
    );
    const selected: DeFiLlamaPoolsResponse["data"] = [];
    let progressed = true;
    while (selected.length < this.maxPools && progressed) {
      progressed = false;
      for (const chain of chains) {
        const next = byChain.get(chain)?.shift();
        if (!next) continue;
        selected.push(next);
        progressed = true;
        if (selected.length >= this.maxPools) break;
      }
    }

    return selected.map(toYieldPool);
  }

  /**
   * The pool as DeFiLlama listed it in the most recent full feed this process
   * fetched, or `undefined` when that feed is older than the poll cadence (so
   * the answer would not be "current") or the pool is not in it.
   *
   * `null` means the feed IS current and the pool is gone from it: DeFiLlama
   * no longer lists it, so it must not be re-scored back to life from a stored
   * copy.
   */
  feedPool(poolId: string): DeFiLlamaYieldPool | null | undefined {
    if (
      !this.fullFeed ||
      Date.now() - this.fullFeed.at > this.poolsCacheTtlSec * 2000
    )
      return undefined;
    return this.fullFeed.byId.get(poolId) ?? null;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseAuditCount(audits: string | number | null | undefined): number {
    if (typeof audits === "number") return audits;
    if (typeof audits === "string") {
      const n = parseInt(audits, 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  private titleCase(slug: string): string {
    return slug
      .split(/[-_]/)
      .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
      .join(" ");
  }
}
