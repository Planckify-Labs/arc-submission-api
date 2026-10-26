import type { ValkeyService } from "../../valkey/valkey.service";
import { loadChainDirectory } from "../targets/chain-directory";
import type { DeFiLlamaYieldPool } from "./defillama.client";
import { MarketRiskClient, riskVerdict } from "./market-risk.client";

/**
 * Exit-side risk signals. The policy is the part that can hurt users if it is
 * wrong in either direction: blocking a healthy protocol strands deposits that
 * should go through, and missing a fresh exploit feeds one. Nothing here may
 * ever say anything about withdrawals being blocked.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T00:00:00Z");
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

describe("riskVerdict", () => {
  beforeEach(() => {
    for (const k of [
      "DEFI_EXPLOIT_BLOCK_DAYS",
      "DEFI_EXPLOIT_WARN_DAYS",
      "DEFI_UTILIZATION_WARN_BPS",
      "DEFI_LST_DISCOUNT_WARN_BPS",
    ])
      delete process.env[k];
  });

  const exploit = (daysAgo: number, lostUsd: number, returnedUsd = 0) => ({
    date: new Date(NOW - daysAgo * DAY).toISOString(),
    lostUsd,
    returnedUsd,
  });

  it("blocks deposits after a recent loss that was not returned", () => {
    expect(riskVerdict({ exploit: exploit(5, 4_750_000) }, NOW)).toEqual({
      depositBlock: "recent_exploit",
      warnings: ["recent_exploit"],
    });
  });

  it("only warns when the funds were returned (Aave v3, March 2026)", () => {
    expect(riskVerdict({ exploit: exploit(5, 862_000, 862_000) }, NOW)).toEqual(
      {
        depositBlock: null,
        warnings: ["past_exploit"],
      },
    );
  });

  it("only warns for an older unreturned loss, and forgets ancient ones", () => {
    expect(
      riskVerdict({ exploit: exploit(90, 1_000) }, NOW).depositBlock,
    ).toBeNull();
    expect(riskVerdict({ exploit: exploit(90, 1_000) }, NOW).warnings).toEqual([
      "past_exploit",
    ]);
    expect(riskVerdict({ exploit: exploit(800, 1_000) }, NOW).warnings).toEqual(
      [],
    );
  });

  it("reads the block window from ops config", () => {
    process.env.DEFI_EXPLOIT_BLOCK_DAYS = "120";
    expect(riskVerdict({ exploit: exploit(90, 1_000) }, NOW).depositBlock).toBe(
      "recent_exploit",
    );
  });

  it("warns, never blocks, on a nearly fully borrowed market or an LST discount", () => {
    expect(
      riskVerdict(
        {
          liquidity: { availableUsd: 10, utilizationBps: 9_900 },
          lstPegBps: -150,
        },
        NOW,
      ),
    ).toEqual({
      depositBlock: null,
      warnings: ["low_liquidity", "lst_discount"],
    });
    expect(
      riskVerdict(
        {
          liquidity: { availableUsd: 1e6, utilizationBps: 7_700 },
          lstPegBps: -20,
        },
        NOW,
      ).warnings,
    ).toEqual([]);
  });
});

describe("MarketRiskClient.forPool", () => {
  const pool: DeFiLlamaYieldPool = {
    pool: "uuid",
    chain: "Arbitrum",
    project: "aave-v3",
    symbol: "USDC",
    tvlUsd: 50_000_000,
    apy: 2.4,
    ilRisk: "no",
    exposure: "single",
    underlyingTokens: [USDC],
  };
  const valkey = {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  } as unknown as ValkeyService;
  const realFetch = global.fetch;

  beforeAll(() => {
    loadChainDirectory([
      {
        chainId: 42161,
        name: "Arbitrum",
        chainSlug: null,
        rpcUrl: "/rpc",
        family: "EVM",
        isTestnet: false,
      },
    ]);
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  function answer(routes: Record<string, unknown>) {
    global.fetch = jest.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([path]) =>
        String(url).includes(path),
      );
      if (!hit) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(hit[1]), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("is silent without market config", async () => {
    delete process.env.MARKET_API_URL;
    expect(await new MarketRiskClient(valkey).forPool(pool, null)).toBeNull();
  });

  it("matches the lending market on chain + underlying and computes utilization", async () => {
    process.env.MARKET_API_URL = "https://market.example";
    process.env.MARKET_API_KEY = "key";
    answer({
      "/api/metadata/aave-v3": { risk: { hacks: [] } },
      "/api/yields/borrow": {
        pools: [
          {
            chain: "ethereum",
            underlyingTokens: [USDC],
            totalSupplyUsd: 1e9,
            totalBorrowUsd: 9.9e8,
          },
          {
            chain: "arbitrum",
            underlyingTokens: [USDC.toUpperCase().replace("0X", "0x")],
            totalSupplyUsd: 219_848_784,
            totalBorrowUsd: 169_064_817,
            availableBorrowUsd: 50_789_692,
          },
        ],
      },
    });
    const signals = await new MarketRiskClient(valkey).forPool(pool, null);
    expect(signals?.liquidity).toEqual({
      availableUsd: 50_789_692,
      utilizationBps: 7690,
    });
    expect(signals?.depositBlock).toBeNull();
    expect(signals?.warnings).toEqual([]);
  });

  it("finds an exploit the per-protocol match missed, from the full hacks list", async () => {
    process.env.MARKET_API_URL = "https://market.example";
    process.env.MARKET_API_KEY = "key";
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    answer({
      "/api/metadata/aave-v3": { risk: { hacks: [] } },
      "/api/hacks": {
        hacks: [
          {
            date: yesterday,
            amountUsd: 21_900,
            returnedUsd: null,
            protocol: "aave-v3",
          },
          {
            date: yesterday,
            amountUsd: 9e9,
            returnedUsd: null,
            protocol: "someone-else",
          },
        ],
      },
    });
    const signals = await new MarketRiskClient(valkey).forPool(pool, null);
    expect(signals?.exploit).toEqual({
      date: yesterday,
      lostUsd: 21_900,
      returnedUsd: 0,
    });
    expect(signals?.depositBlock).toBe("recent_exploit");
  });

  it("returns null when every source failed: nothing is claimed", async () => {
    process.env.MARKET_API_URL = "https://market.example";
    process.env.MARKET_API_KEY = "key";
    answer({});
    expect(await new MarketRiskClient(valkey).forPool(pool, null)).toBeNull();
  });
});
