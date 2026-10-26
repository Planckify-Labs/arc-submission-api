/**
 * TargetResolverService — Nest wrapper around the resolver registry
 * (spec §3.3, §5, §11 Q4).
 *
 * Runs at poll/score time (addresses are stable), off the request path. It
 * owns:
 *   - the ResolverContext the family resolvers consume (Valkey-cached +
 *     inflight-deduped protocol-API fetches, on-chain validation),
 *   - the single `resolve(pool)` entry the score worker calls.
 *
 * Resolved targets are persisted on `OpportunityCache.depositTarget` (the DB
 * column) AND surface through the Valkey row-cache in StrategiesService
 * (spec Q4 — cache on Valkey too). Vault-list fetches are Valkey-cached here
 * so per-pool scoring jobs don't each hit the protocol API.
 */

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ValkeyService } from "../../valkey/valkey.service";
import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { bootTargetResolvers } from "./bootstrap";
import {
  type ChainDirectoryRow,
  chainDirectoryDiagnostics,
  loadChainDirectory,
} from "./chain-directory";
import { resolveTarget } from "./registry";
import { getPublicClientForChain, resetRpcClients } from "./rpc";
import type {
  DepositTarget,
  EvmReadClient,
  FetchJsonInit,
  ResolverContext,
} from "./types";
import { setAssetPriceLookup, validateTarget } from "./validation";
import {
  AlchemyPricesClient,
  alchemyNetworkForChainId,
} from "../external/alchemy-prices.client";

const FETCH_TIMEOUT_MS = 20_000;
/**
 * How long a chain-directory snapshot is trusted. Chain rows change on the
 * order of "ops onboards a chain", so this only needs to be short enough that a
 * new chain starts resolving without a restart.
 */
const CHAIN_DIRECTORY_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class TargetResolverService implements OnModuleInit {
  private readonly logger = new Logger(TargetResolverService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly ctx: ResolverContext;
  private chainDirectoryLoadedAt = 0;
  private chainDirectoryLoad: Promise<void> | null = null;

  constructor(
    private readonly valkey: ValkeyService,
    private readonly prisma: PrismaService,
    private readonly alchemyPrices: AlchemyPricesClient,
  ) {
    bootTargetResolvers();
    // The TVL band for non-stable vaults needs a USD price; this client is the
    // one budgeted, cached place the backend prices tokens. A chain Alchemy
    // does not serve answers null, and the band is skipped there.
    setAssetPriceLookup(async (chainId, asset) => {
      const network = alchemyNetworkForChainId(chainId);
      if (!network) return null;
      const prices = await this.alchemyPrices.getPricesByAddress([
        { network, address: asset },
      ]);
      return prices.get(`${network}:${asset.toLowerCase()}`) ?? null;
    });
    this.ctx = {
      fetchJsonCached: (cacheKey, url, ttlSec, init) =>
        this.fetchJsonCached(cacheKey, url, ttlSec, init),
      validate: (target, pool) => validateTarget(target, pool),
      // Resolve-time on-chain reads (Curve arity, Solidly `stable`, Balancer
      // poolId). Chain state, not a third-party API — see the ResolverContext
      // doc comment.
      publicClient: (chainId) =>
        getPublicClientForChain(chainId) as EvmReadClient | null,
    };
  }

  async onModuleInit(): Promise<void> {
    // Load once at boot so the very first scoring pass can resolve targets.
    // Non-fatal: an empty directory means every pool degrades to Manual, which
    // is the correct-by-default behaviour, not an outage.
    await this.refreshChainDirectory().catch(() => undefined);
  }

  /**
   * Pull the supported-chain set from the `Blockchain` table into the
   * directory. Chains are data, not constants (see chain-directory.ts) — this
   * is the only place the DB is read for that, and everything downstream
   * (`resolveEvmChainId`, the RPC clients, the score worker's namespace
   * mapping) reads the loaded snapshot synchronously.
   */
  private async refreshChainDirectory(force = false): Promise<void> {
    const fresh =
      Date.now() - this.chainDirectoryLoadedAt < CHAIN_DIRECTORY_TTL_MS;
    if (!force && fresh) return;
    if (this.chainDirectoryLoad) return this.chainDirectoryLoad;

    this.chainDirectoryLoad = (async () => {
      try {
        const rows = await this.prisma.blockchain.findMany({
          where: { isActive: true },
          select: {
            chainId: true,
            name: true,
            chainSlug: true,
            rpcUrl: true,
            type: true,
            isTestnet: true,
            tokens: { where: { isActive: true }, select: { symbol: true } },
          },
          // Mainnet first so a similarly-named testnet row can never shadow it
          // in the by-name index (chain-directory keeps the first writer).
          orderBy: [{ isTestnet: "asc" }, { name: "asc" }],
        });
        loadChainDirectory(
          rows.map(
            (r): ChainDirectoryRow => ({
              chainId: r.chainId,
              name: r.name,
              chainSlug: r.chainSlug,
              rpcUrl: r.rpcUrl,
              family: r.type,
              isTestnet: r.isTestnet,
              assetSymbols: r.tokens.map((t) => t.symbol),
            }),
          ),
        );
        resetRpcClients();
        this.chainDirectoryLoadedAt = Date.now();
        this.logger.log(
          `[chain-directory] loaded ${JSON.stringify(chainDirectoryDiagnostics())}`,
        );
      } catch (err) {
        this.logger.warn(
          `[chain-directory] load failed: ${(err as Error)?.message ?? err} — pools degrade to manual until the next refresh`,
        );
      } finally {
        this.chainDirectoryLoad = null;
      }
    })();
    return this.chainDirectoryLoad;
  }

  /**
   * Resolve a pool's on-chain deposit target, or `null` (→ manual). Never
   * throws — a resolver blowup degrades the pool to manual, correct-by-default.
   */
  async resolve(pool: DeFiLlamaYieldPool): Promise<DepositTarget | null> {
    await this.refreshChainDirectory();
    try {
      return await resolveTarget(pool, this.ctx);
    } catch (err) {
      this.logger.warn(
        `[resolve] pool=${pool.pool} project=${pool.project} failed: ${
          (err as Error)?.message ?? err
        } — degrading to manual`,
      );
      return null;
    }
  }

  /** Ensure the chain directory is loaded — for callers outside `resolve`. */
  async ensureChainDirectory(): Promise<void> {
    await this.refreshChainDirectory();
  }

  /** Valkey-cached + inflight-deduped JSON GET/POST. Returns null on failure. */
  private async fetchJsonCached<T>(
    cacheKey: string,
    url: string,
    ttlSec: number,
    init?: FetchJsonInit<T>,
  ): Promise<T | null> {
    const cached = await this.valkey.get<T>(cacheKey).catch(() => null);
    if (cached !== null && cached !== undefined) return cached;

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing as Promise<T | null>;

    const task = (async (): Promise<T | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers ?? { Accept: "application/json" },
          body: init?.body,
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`[fetchJsonCached] ${url} -> HTTP ${res.status}`);
          return null;
        }
        const json = (await res.json()) as T;
        if (init?.cacheIf && !init.cacheIf(json)) return json;
        await this.valkey
          .set(cacheKey, json as object, { ttl: ttlSec })
          .catch(() => undefined);
        return json;
      } catch (err) {
        this.logger.warn(
          `[fetchJsonCached] ${url} failed: ${(err as Error)?.message ?? err}`,
        );
        return null;
      } finally {
        clearTimeout(timer);
        this.inflight.delete(cacheKey);
      }
    })();
    this.inflight.set(cacheKey, task);
    return task;
  }
}
