const getTokens = jest.fn();
const getConnections = jest.fn();
jest.mock("@lifi/sdk", () => ({
  ...jest.requireActual("@lifi/sdk"),
  createConfig: jest.fn(),
  getTokens: (...args: unknown[]) => getTokens(...args),
  getConnections: (...args: unknown[]) => getConnections(...args),
}));

import { LifiBridgeAdapter } from "./lifi.adapter";

const BASE = "eip155:8453";
const lifiToken = (symbol: string, address: string, status: string) => ({
  chainId: 8453,
  address,
  symbol,
  name: symbol,
  decimals: 6,
  priceUSD: "1",
  verificationStatus: status,
});

function makeAdapter() {
  return new LifiBridgeAdapter({ get: () => undefined } as never);
}

describe("LifiBridgeAdapter.listTokens (token picker)", () => {
  beforeEach(() => getTokens.mockReset());

  it("asks for the most traded tokens and drops ones LI.FI flags", async () => {
    getTokens.mockResolvedValue({
      tokens: {
        8453: [
          lifiToken("USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "verified"),
          lifiToken("$COOL", "0x2f85d37200000000000000000000000000000000", "flagged"),
          lifiToken("NEW", "0x1111111111111111111111111111111111111111", "unverified"),
        ],
      },
    });
    const out = await makeAdapter().listTokens(BASE);
    expect(getTokens).toHaveBeenCalledWith(
      expect.objectContaining({ chains: [8453], orderBy: "volumeUSD24H" }),
    );
    expect(out.map((t) => t.symbol)).toEqual(["USDC", "NEW"]);
    expect(out[0].caip19).toBe(`${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`);
  });

  it("serves the cache, and the last good list when a refresh fails", async () => {
    const adapter = makeAdapter();
    getTokens.mockResolvedValueOnce({
      tokens: { 8453: [lifiToken("USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "verified")] },
    });
    await adapter.listTokens(BASE);
    await adapter.listTokens(BASE);
    expect(getTokens).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for a chain LI.FI does not know", async () => {
    const out = await makeAdapter().listTokens("stellar:pubnet");
    expect(out).toEqual([]);
    expect(getTokens).not.toHaveBeenCalled();
  });
});

describe("LifiBridgeAdapter routable pairs (connections)", () => {
  beforeEach(() => {
    getTokens.mockReset();
    getConnections.mockReset();
  });
  const SEP_BASE = "eip155:84532";
  const SEP_ARB = "eip155:421614";
  const usdcBase = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  const wethBase = "0x4200000000000000000000000000000000000006";
  const usdcArb = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";

  it("pairs the same asset only where LI.FI connects both sides", async () => {
    getTokens.mockImplementation(async ({ chains }: { chains: number[] }) => ({
      tokens:
        chains[0] === 84532
          ? { 84532: [lifiToken("USDC", usdcBase, "verified"), lifiToken("WETH", wethBase, "verified")] }
          : { 421614: [lifiToken("USDC", usdcArb, "verified")] },
    }));
    getConnections.mockResolvedValue({
      connections: [
        {
          fromChainId: 84532,
          toChainId: 421614,
          // WETH is listed on Base Sepolia but NOT connected: left out.
          fromTokens: [{ chainId: 84532, address: usdcBase.toUpperCase().replace("0X", "0x") }],
          toTokens: [{ chainId: 421614, address: usdcArb }],
        },
      ],
    });
    const pairs = await makeAdapter().listRoutablePairs(SEP_BASE, SEP_ARB);
    expect(pairs.map((p) => [p.from.symbol, p.to.symbol])).toEqual([["USDC", "USDC"]]);
  });

  it("has nothing where LI.FI has no connection (testnet to mainnet)", async () => {
    getTokens.mockResolvedValue({ tokens: {} });
    getConnections.mockResolvedValue({ connections: [] });
    expect(await makeAdapter().listRoutablePairs(SEP_BASE, "eip155:42161")).toEqual([]);
  });

  it("throws when LI.FI cannot be reached, so the caller fails closed", async () => {
    getTokens.mockResolvedValue({ tokens: {} });
    getConnections.mockRejectedValue(new Error("down"));
    await expect(makeAdapter().listRoutablePairs(SEP_BASE, SEP_ARB)).rejects.toThrow();
  });
});
