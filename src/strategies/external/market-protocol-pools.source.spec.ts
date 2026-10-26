import { loadChainDirectory } from "../targets/chain-directory";
import { MarketProtocolPoolsSource } from "./market-protocol-pools.source";

/**
 * Pools from protocols' own APIs enter the same pipeline as the feed, so they
 * get the feed's chain rule: only active mainnet `Blockchain` rows. And a
 * market API that is unset or failing never sinks the poll.
 */

const pool = (overrides: Record<string, unknown> = {}) => ({
  pool: "f1e2d3c4-0000-5000-8000-000000000000",
  chain: "Arc",
  project: "morpho-blue",
  symbol: "USDC",
  poolMeta: "Galaxy USDC",
  tvlUsd: 94_889_583,
  apy: 3.59,
  underlyingTokens: ["0x3600000000000000000000000000000000000000"],
  ilRisk: "no",
  exposure: "single",
  address: "0x0000000000000000000000000000000000000001",
  ...overrides,
});

describe("MarketProtocolPoolsSource", () => {
  const realFetch = global.fetch;
  beforeAll(() => {
    loadChainDirectory([
      {
        chainId: 5042,
        name: "Arc",
        chainSlug: null,
        rpcUrl: "/r",
        family: "EVM",
        isTestnet: false,
      },
      {
        chainId: 5042002,
        name: "Arc Testnet",
        chainSlug: null,
        rpcUrl: "/r",
        family: "EVM",
        isTestnet: true,
      },
    ]);
  });
  beforeEach(() => {
    process.env.MARKET_API_URL = "https://market.example";
    process.env.MARKET_API_KEY = "key";
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const serve = (body: unknown, status = 200) => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify(body), { status }),
    ) as unknown as typeof fetch;
  };

  it("keeps pools on directory mainnets, in DeFiLlama's shape", async () => {
    serve({
      pools: [
        pool(),
        pool({ chain: "Arc Testnet" }),
        pool({ chain: "Nowhere" }),
        pool({ tvlUsd: 0 }),
        pool({ symbol: undefined }),
      ],
    });
    const pools = await new MarketProtocolPoolsSource().getPools();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      chain: "Arc",
      project: "morpho-blue",
      poolMeta: "Galaxy USDC",
    });
    expect(pools[0]).not.toHaveProperty("address");
  });

  it("returns nothing, without throwing, when unset or failing", async () => {
    serve({}, 500);
    expect(await new MarketProtocolPoolsSource().getPools()).toEqual([]);
    delete process.env.MARKET_API_KEY;
    expect(await new MarketProtocolPoolsSource().getPools()).toEqual([]);
  });
});
