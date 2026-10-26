import { Injectable, Logger } from "@nestjs/common";
import { marketApiConfig } from "../targets/candidates/market-pool-address.source";
import { findChainByName } from "../targets/chain-directory";
import type { DeFiLlamaYieldPool } from "./defillama.client";

/**
 * Yield pools our market API reads from protocols' OWN APIs, for chains where
 * DeFiLlama's free feed has none for that protocol (`GET
 * /api/pools/protocol-sources`). The first source is Morpho Vault V2: Morpho
 * runs vaults on Arc holding ~$170M while DeFiLlama lists no Morpho pool
 * there, so without this the chain reads "no options".
 *
 * The rows arrive DeFiLlama-shaped, with the id DeFiLlama itself would mint
 * (UUIDv5 of "<address>-<chain>"), and go through the same scoring, resolver
 * and validator path as feed rows: the address is only a candidate the
 * resolver must vouch for and the validator must prove on-chain. Like the feed,
 * only chains with an active mainnet `Blockchain` row are kept.
 *
 * Unconfigured or failing market API = no rows, never an error for the poll.
 */

interface ProtocolPool extends DeFiLlamaYieldPool {
  source?: string;
}

@Injectable()
export class MarketProtocolPoolsSource {
  private readonly logger = new Logger(MarketProtocolPoolsSource.name);

  async getPools(): Promise<DeFiLlamaYieldPool[]> {
    const config = marketApiConfig();
    if (!config) return [];
    try {
      const res = await fetch(`${config.url}/api/pools/protocol-sources`, {
        headers: { Accept: "application/json", "X-API-Key": config.key },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        this.logger.warn(`[protocol-pools] HTTP ${res.status}`);
        return [];
      }
      const body = (await res.json()) as { pools?: ProtocolPool[] };
      return (body.pools ?? []).filter(isUsablePool).map(toYieldPool);
    } catch (err) {
      this.logger.warn(`[protocol-pools] ${(err as Error)?.message ?? err}`);
      return [];
    }
  }
}

function isUsablePool(p: ProtocolPool): boolean {
  const row = findChainByName(p?.chain);
  return (
    !!row &&
    !row.isTestnet &&
    typeof p.pool === "string" &&
    typeof p.project === "string" &&
    typeof p.symbol === "string" &&
    typeof p.tvlUsd === "number" &&
    p.tvlUsd > 0 &&
    typeof p.apy === "number"
  );
}

function toYieldPool(p: ProtocolPool): DeFiLlamaYieldPool {
  return {
    pool: p.pool,
    chain: p.chain,
    project: p.project,
    symbol: p.symbol,
    tvlUsd: p.tvlUsd,
    apy: p.apy,
    apyBase: p.apyBase ?? undefined,
    apyReward: p.apyReward ?? undefined,
    ilRisk: p.ilRisk === "yes" ? "yes" : "no",
    exposure: p.exposure ?? "single",
    poolMeta: p.poolMeta ?? null,
    underlyingTokens: Array.isArray(p.underlyingTokens)
      ? p.underlyingTokens
      : undefined,
  };
}
