/**
 * Focused coverage for the two pieces added to fix "no way to see DeFi
 * position value/yield": the `currentApy` join on `getPositions` and the
 * `getAssetPrices` batch proxy. Full `StrategiesService` has heavy Prisma
 * surface area; this mocks only what these two methods touch.
 */

import { StrategiesService } from "./strategies.service";

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    strategyPosition: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    opportunityCache: {
      findMany: jest.fn(),
    },
    ...overrides,
  };
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  alchemyPrices: {
    getPricesByAddress: jest.Mock;
    getPricesBySymbol: jest.Mock;
  },
) {
  // Reconciliation's on-chain scan (discoverCometPositions) calls
  // getPublicClientForChain, which returns null when the chain directory
  // hasn't been loaded (never is, in this unit — TargetResolverService's
  // onModuleInit doesn't run here) — so it's a no-op without needing a
  // mock. Zerion discovery is stubbed to empty so these APY/price-focused
  // tests aren't exercising reconciliation at all.
  const zerionClient = { getPositions: jest.fn().mockResolvedValue([]) };
  return new StrategiesService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    {} as any,
    {} as any,
    alchemyPrices as any,
    zerionClient as any,
  );
}

describe("StrategiesService.getPositions — currentApy join", () => {
  it("prefers the exact pool via poolId over the (protocol, chain, namespace) fallback", async () => {
    const prisma = fakePrisma();
    prisma.strategyPosition.findMany.mockResolvedValue([
      {
        id: "p1",
        poolId: "pool-abc",
        protocolSlug: "compound-v3",
        chainId: 8453,
        namespace: "eip155",
      },
    ]);
    prisma.opportunityCache.findMany.mockResolvedValue([
      { poolId: "pool-abc", apy: "4.20" },
    ]);
    const service = makeService(prisma, {
      getPricesByAddress: jest.fn(),
      getPricesBySymbol: jest.fn(),
    });

    const [position] = await service.getPositions("user-1", "0xwallet");

    expect(position.currentApy).toBe(4.2);
    // Only the poolId-keyed lookup should run — no legacy fallback query.
    // (The vault-discovery scan reads the cache too; it is not an APY join.)
    const apyJoins = prisma.opportunityCache.findMany.mock.calls.filter(
      ([arg]: [{ where?: Record<string, unknown> }]) =>
        !arg?.where || !("depositTarget" in arg.where),
    );
    expect(apyJoins).toHaveLength(1);
    expect(prisma.opportunityCache.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { poolId: { in: ["pool-abc"] } } }),
    );
  });

  it("falls back to (protocolSlug, chainId, namespace) for legacy positions with no poolId", async () => {
    const prisma = fakePrisma();
    prisma.strategyPosition.findMany.mockResolvedValue([
      {
        id: "p1",
        poolId: null,
        protocolSlug: "aave-v3-base",
        chainId: 8453,
        namespace: "eip155",
      },
    ]);
    prisma.opportunityCache.findMany.mockResolvedValue([
      {
        protocolSlug: "aave-v3-base",
        chainId: 8453,
        namespace: "eip155",
        apy: "3.10",
      },
    ]);
    const service = makeService(prisma, {
      getPricesByAddress: jest.fn(),
      getPricesBySymbol: jest.fn(),
    });

    const [position] = await service.getPositions("user-1", "0xwallet");

    expect(position.currentApy).toBe(3.1);
  });

  it("resolves to null when the pool has aged out of OpportunityCache", async () => {
    const prisma = fakePrisma();
    prisma.strategyPosition.findMany.mockResolvedValue([
      {
        id: "p1",
        poolId: "stale-pool",
        protocolSlug: "compound-v3",
        chainId: 8453,
        namespace: "eip155",
      },
    ]);
    prisma.opportunityCache.findMany.mockResolvedValue([]);
    const service = makeService(prisma, {
      getPricesByAddress: jest.fn(),
      getPricesBySymbol: jest.fn(),
    });

    const [position] = await service.getPositions("user-1", "0xwallet");

    expect(position.currentApy).toBeNull();
  });
});

describe("StrategiesService.getAssetPrices", () => {
  it("routes a contract-bearing query on a mapped chain through by-address", async () => {
    const prisma = fakePrisma();
    const getPricesByAddress = jest.fn().mockResolvedValue(
      new Map([["base-mainnet:0xusdc", 1]]),
    );
    const getPricesBySymbol = jest.fn().mockResolvedValue(new Map());
    const service = makeService(prisma, {
      getPricesByAddress,
      getPricesBySymbol,
    });

    const [result] = await service.getAssetPrices([
      { chainId: 8453, assetSymbol: "USDC", assetContract: "0xUSDC" },
    ]);

    expect(getPricesByAddress).toHaveBeenCalledWith([
      { network: "base-mainnet", address: "0xUSDC" },
    ]);
    expect(result.usd).toBe(1);
  });

  it("routes a native (no-contract) query through by-symbol", async () => {
    const prisma = fakePrisma();
    const getPricesByAddress = jest.fn().mockResolvedValue(new Map());
    const getPricesBySymbol = jest
      .fn()
      .mockResolvedValue(new Map([["ETH", 3000]]));
    const service = makeService(prisma, {
      getPricesByAddress,
      getPricesBySymbol,
    });

    const [result] = await service.getAssetPrices([
      { chainId: 8453, assetSymbol: "ETH" },
    ]);

    expect(getPricesBySymbol).toHaveBeenCalledWith(["ETH"]);
    expect(result.usd).toBe(3000);
  });

  it("resolves to null (never throws) for an unmapped chain id with a contract", async () => {
    const prisma = fakePrisma();
    const getPricesByAddress = jest.fn().mockResolvedValue(new Map());
    const getPricesBySymbol = jest.fn().mockResolvedValue(new Map());
    const service = makeService(prisma, {
      getPricesByAddress,
      getPricesBySymbol,
    });

    const [result] = await service.getAssetPrices([
      { chainId: 999999, assetSymbol: "FOO", assetContract: "0xfoo" },
    ]);

    expect(result.usd).toBeNull();
  });
});
