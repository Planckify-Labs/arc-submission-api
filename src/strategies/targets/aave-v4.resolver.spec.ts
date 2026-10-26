import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { AaveV4Resolver, spokeForPool } from "./aave-v4.resolver";
import { loadChainDirectory } from "./chain-directory";
import type { ResolverContext } from "./types";

/**
 * Aave v4 identity: a hub pool may only resolve into Aave's own
 * TokenizationSpoke for that asset ON THAT HUB, proven on chain. Each case is
 * a way the wrong market could otherwise be picked.
 */

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CORE = "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9";
const PRIME = "0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931";
const CORE_USDC = "0x531E90a2376902DE8915789Fcc1075e3B0c153E7";
const PRIME_USDC = "0x486415fb1F8b062c89ED548f871cf64304AACb31";

const book = {
  1: [
    {
      vault: CORE_USDC,
      asset: USDC,
      hub: CORE,
      hubName: "CORE",
      label: "waCoreUSDC",
    },
    {
      vault: PRIME_USDC,
      asset: USDC,
      hub: PRIME,
      hubName: "PRIME",
      label: "waPrimeUSDC",
    },
    {
      vault: "0xaed7c529bD2878170B61C758DfAa215AC7a4FD07",
      asset: USDC,
      hub: "0x62d63197660c080236193CA60b70E49A08E90368",
      hubName: "GLOBAL_DOLLAR",
      label: "waGlobalDollarUSDC",
    },
  ],
} as const;

function pool(overrides: Partial<DeFiLlamaYieldPool> = {}): DeFiLlamaYieldPool {
  return {
    pool: "p",
    chain: "Ethereum",
    project: "aave-v4",
    symbol: "USDC",
    poolMeta: "Core",
    tvlUsd: 6_500_000,
    apy: 6.1,
    ilRisk: "no",
    exposure: "single",
    underlyingTokens: [USDC],
    ...overrides,
  };
}

describe("spokeForPool", () => {
  it("picks the spoke on the pool's hub, not another hub's for the same asset", () => {
    expect(spokeForPool(pool(), 1, book)?.vault).toBe(CORE_USDC);
    expect(spokeForPool(pool({ poolMeta: "Prime" }), 1, book)?.vault).toBe(
      PRIME_USDC,
    );
  });

  it('matches multi-word hub names ("Global Dollar" vs GLOBAL_DOLLAR)', () => {
    expect(
      spokeForPool(pool({ poolMeta: "Global Dollar" }), 1, book)?.label,
    ).toBe("waGlobalDollarUSDC");
  });

  it("refuses a row with no hub label, or a spoke-level label, even with one candidate", () => {
    const single = { 1: [book[1][0]] };
    expect(spokeForPool(pool({ poolMeta: null }), 1, single)).toBeNull();
    expect(spokeForPool(pool({ poolMeta: "Bluechip" }), 1, single)).toBeNull();
  });

  it("refuses another asset and another chain", () => {
    expect(
      spokeForPool(
        pool({
          underlyingTokens: ["0x1111111111111111111111111111111111111111"],
        }),
        1,
        book,
      ),
    ).toBeNull();
    expect(spokeForPool(pool(), 5042, book)).toBeNull();
  });
});

describe("AaveV4Resolver", () => {
  beforeAll(() => {
    loadChainDirectory([
      {
        chainId: 1,
        name: "Ethereum",
        chainSlug: null,
        rpcUrl: "/r",
        family: "EVM",
        isTestnet: false,
      },
    ]);
  });

  const ctx = (
    onChain: { hub: string; asset: string },
    validate = jest.fn(async () => true),
  ) =>
    ({
      fetchJsonCached: async () => null,
      validate,
      publicClient: () => ({
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === "hub" ? onChain.hub : onChain.asset,
      }),
    }) as unknown as ResolverContext;

  it("emits an erc4626 target when the chain agrees, validating without the TVL band", async () => {
    const validate = jest.fn(async () => true);
    const target = await AaveV4Resolver.resolve(
      pool(),
      ctx({ hub: CORE, asset: USDC }, validate),
    );
    expect(target).toEqual({
      kind: "erc4626",
      vault: CORE_USDC.toLowerCase(),
      asset: USDC.toLowerCase(),
    });
    expect(validate).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ tvlUsd: 0 }),
    );
  });

  it("refuses when the spoke on chain reports a different hub or asset", async () => {
    expect(
      await AaveV4Resolver.resolve(pool(), ctx({ hub: PRIME, asset: USDC })),
    ).toBeNull();
    expect(
      await AaveV4Resolver.resolve(
        pool(),
        ctx({ hub: CORE, asset: "0x2222222222222222222222222222222222222222" }),
      ),
    ).toBeNull();
  });

  it("refuses when the ERC-4626 checks refuse (exit cost, holder exit, gates)", async () => {
    expect(
      await AaveV4Resolver.resolve(
        pool(),
        ctx(
          { hub: CORE, asset: USDC },
          jest.fn(async () => false),
        ),
      ),
    ).toBeNull();
  });
});
