import type { ConfigService } from "@nestjs/config";
import type { ValkeyService } from "../../valkey/valkey.service";
import {
  type ChainDirectoryRow,
  loadChainDirectory,
} from "../targets/chain-directory";
import { DeFiLlamaClient } from "./defillama.client";

/**
 * Which DeFiLlama pools the ingester keeps. Chains come from the chain
 * directory (`Blockchain` rows) and each chain's own `Token` symbols are
 * admitted, so nothing here names a chain or asset the code knows about: the
 * fixtures below are the "database", and the assertions are about how the
 * client reads it.
 */

type FeedPool = Parameters<DeFiLlamaClient["filterPools"]>[0][number];

function row(overrides: Partial<ChainDirectoryRow>): ChainDirectoryRow {
  return {
    chainId: null,
    name: "Chain",
    chainSlug: null,
    rpcUrl: "/rpc",
    family: "EVM",
    isTestnet: false,
    ...overrides,
  };
}

function pool(overrides: Partial<FeedPool>): FeedPool {
  return {
    pool: `pool-${Math.random()}`,
    chain: "Ethereum",
    project: "some-protocol",
    symbol: "USDC",
    tvlUsd: 50_000_000,
    apy: 4,
    ilRisk: "no",
    exposure: "single",
    ...overrides,
  };
}

function client(): DeFiLlamaClient {
  const config = {
    get: (key: string) =>
      ({
        DEFILLAMA_YIELDS_URL: "https://yields.example",
        DEFILLAMA_API_URL: "https://api.example",
      })[key],
  } as unknown as ConfigService;
  return new DeFiLlamaClient(config, {} as ValkeyService);
}

function keptChains(pools: FeedPool[]): string[] {
  return client()
    ["filterPools"](pools)
    .map((p) => p.chain)
    .sort();
}

describe("DeFiLlamaClient.filterPools", () => {
  beforeEach(() => {
    loadChainDirectory([
      row({ chainId: 1, name: "Ethereum", assetSymbols: ["ETH", "USDC"] }),
      row({ chainId: 143, name: "Monad", assetSymbols: ["AUSD", "MON"] }),
      row({
        name: "Stellar",
        chainSlug: "stellar-mainnet",
        family: "STELLAR",
        assetSymbols: ["USDC", "XLM"],
      }),
      row({ chainId: 84532, name: "Base Sepolia", isTestnet: true }),
      row({ chainId: 146, name: "Sonic", assetSymbols: ["S"] }),
    ]);
  });

  it("keeps pools on any chain that has a directory row, and drops the rest", () => {
    expect(
      keptChains([
        pool({ chain: "Ethereum" }),
        pool({ chain: "Monad" }),
        pool({ chain: "Optimism" }),
      ]),
    ).toEqual(["Ethereum", "Monad"]);
  });

  it("never lets a testnet row claim a feed pool", () => {
    expect(keptChains([pool({ chain: "Base Sepolia" })])).toEqual([]);
  });

  it("admits a chain's own Token symbols on that chain only", () => {
    const kept = client()["filterPools"]([
      pool({ chain: "Monad", symbol: "EARNAUSD" }),
      pool({ chain: "Stellar", symbol: "XLM", tvlUsd: 1_000_000 }),
      // AUSD is a Monad token row, not an Ethereum one.
      pool({ chain: "Ethereum", symbol: "AUSD" }),
    ]);
    expect(kept.map((p) => `${p.chain}:${p.symbol}`).sort()).toEqual([
      "Monad:EARNAUSD",
      "Stellar:XLM",
    ]);
  });

  it("ignores token symbols too short to substring-match safely", () => {
    expect(
      keptChains([pool({ chain: "Sonic", symbol: "WOOFIS-STAKED" })]),
    ).toEqual([]);
  });

  it("applies the lower floor to non-EVM families, read from the row", () => {
    expect(
      keptChains([
        pool({ chain: "Stellar", tvlUsd: 1_000_000 }),
        pool({ chain: "Monad", tvlUsd: 1_000_000 }),
      ]),
    ).toEqual(["Stellar"]);
  });

  it("resolves the feed's chain name through the directory's aliases", () => {
    const before = process.env.STRATEGIES_CHAIN_ALIASES;
    process.env.STRATEGIES_CHAIN_ALIASES = JSON.stringify({
      "stellar pubnet": "stellar-mainnet",
    });
    try {
      expect(
        keptChains([pool({ chain: "Stellar Pubnet", tvlUsd: 1_000_000 })]),
      ).toEqual(["Stellar Pubnet"]);
    } finally {
      process.env.STRATEGIES_CHAIN_ALIASES = before;
    }
  });
});
