/**
 * Position reconciliation/discovery — the fix for "I deposited into
 * Compound v3 but the app shows nothing." Two root causes, confirmed live
 * 2026-08-16: (1) `createPosition` required a pre-existing `UserStrategy`
 * and silently dropped the write when the wallet had none (both DB tables
 * were empty despite a real signed deposit — `ensureUserStrategy` fixes
 * this going forward); (2) even fixed going forward, a deposit already
 * missing from the DB needed a discovery path, since Zerion's own
 * classification is demonstrably incomplete (a live Compound III `cUSDTv3`
 * balance came back as plain `"wallet"` type, not `"deposit"`).
 */

const cometMarketsFixture: Record<number, string[]> = {
  8453: ["0xC0Met000000000000000000000000000000001"],
};

jest.mock("./targets/address-book", () => ({
  COMET_MARKETS: cometMarketsFixture,
  cometMarkets: (chainId: number) => cometMarketsFixture[chainId] ?? [],
}));

jest.mock("./targets/chain-directory", () => ({
  findChainById: () => ({ name: "Base" }),
}));

const mockReadContract = jest.fn();
// Arc: a chain with in-app vaults that Zerion does not index.
const ARC_CHAIN_ID = 5042;
jest.mock("./targets/rpc", () => ({
  getPublicClientForChain: (chainId: number) =>
    chainId === 8453 || chainId === ARC_CHAIN_ID
      ? { readContract: mockReadContract }
      : null,
}));

import { StrategiesService } from "./strategies.service";

const COMET = "0xC0Met000000000000000000000000000000001".toLowerCase();
const BASE_TOKEN = "0xUsdcBaseToken00000000000000000000000001".toLowerCase();
const WALLET = "0xWallet00000000000000000000000000000001".toLowerCase();

function fakePrisma() {
  return {
    strategyPosition: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "created-1",
        ...data,
      })),
    },
    userStrategy: {
      findFirst: jest.fn().mockResolvedValue({ id: "strategy-1", tier: "conservative" }),
      create: jest.fn(),
    },
    opportunityCache: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  zerionPositions: unknown[] = [],
) {
  const alchemyPrices = {
    getPricesByAddress: jest.fn().mockResolvedValue(new Map()),
    getPricesBySymbol: jest.fn().mockResolvedValue(new Map([["USDC", 1]])),
  };
  const zerionClient = {
    getPositions: jest.fn().mockResolvedValue(zerionPositions),
  };
  return new StrategiesService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    {} as any,
    {} as any,
    alchemyPrices as any,
    zerionClient as any,
  );
}

beforeEach(() => {
  mockReadContract.mockReset();
});

describe("discoverCometPositions (on-chain address-book scan)", () => {
  it("backfills a StrategyPosition for a nonzero Comet balance with no existing DB row", async () => {
    mockReadContract.mockImplementation(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === COMET && functionName === "balanceOf") return 10_500_000n;
        if (address.toLowerCase() === COMET && functionName === "baseToken") return BASE_TOKEN;
        if (address.toLowerCase() === BASE_TOKEN && functionName === "symbol") return "USDC";
        if (address.toLowerCase() === BASE_TOKEN && functionName === "decimals") return 6;
        throw new Error(`unexpected call ${functionName} on ${address}`);
      },
    );
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).toHaveBeenCalledTimes(1);
    const created = prisma.strategyPosition.create.mock.calls[0][0].data;
    expect(created.protocolSlug).toBe("compound-v3");
    expect(created.chainId).toBe(8453);
    expect(created.assetContract).toBe(BASE_TOKEN);
    expect(created.amountAtDeposit).toBe("10500000");
    expect(created.currentAmountRaw).toBe("10500000");
    expect(result).toHaveLength(1);
    expect(result[0].protocolSlug).toBe("compound-v3");
  });

  it("does not backfill when an active DB row already covers this (chain, asset)", async () => {
    mockReadContract.mockImplementation(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === COMET && functionName === "balanceOf") return 10_500_000n;
        if (address.toLowerCase() === COMET && functionName === "baseToken") return BASE_TOKEN;
        return 0n;
      },
    );
    const prisma = fakePrisma();
    prisma.strategyPosition.findMany.mockResolvedValue([
      {
        id: "existing-1",
        protocolSlug: "compound-v3",
        chainId: 8453,
        namespace: "eip155",
        assetContract: BASE_TOKEN,
        status: "active",
        poolId: null,
      },
    ]);
    const service = makeService(prisma);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).not.toHaveBeenCalled();
  });

  it("skips a market with a zero balance", async () => {
    mockReadContract.mockImplementation(
      async ({ functionName }: { functionName: string }) =>
        functionName === "balanceOf" ? 0n : BASE_TOKEN,
    );
    const prisma = fakePrisma();
    const service = makeService(prisma);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).not.toHaveBeenCalled();
  });

  it("auto-creates a default UserStrategy (matching the tier if known) when the wallet has none", async () => {
    mockReadContract.mockImplementation(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === COMET && functionName === "balanceOf") return 5_000_000n;
        if (address.toLowerCase() === COMET && functionName === "baseToken") return BASE_TOKEN;
        if (functionName === "symbol") return "USDC";
        return 6;
      },
    );
    const prisma = fakePrisma();
    prisma.userStrategy.findFirst.mockResolvedValue(null);
    prisma.userStrategy.create.mockResolvedValue({ id: "auto-strategy-1" });
    const service = makeService(prisma);

    await service.getPositions("user-1", WALLET);

    expect(prisma.userStrategy.create).toHaveBeenCalledTimes(1);
    expect(prisma.strategyPosition.create).toHaveBeenCalledTimes(1);
  });
});

describe("discoverZerionPositions (best-effort secondary source)", () => {
  const zerionDeposit = {
    dappId: "yearn-v3",
    protocolName: "Yearn V3",
    poolAddress: "0xpool",
    zerionChainId: "base",
    assetSymbol: "USDC",
    assetContract: "0xZerionAsset000000000000000000000000001",
    quantityRaw: "1000000",
    decimals: 6,
    valueUsd: 5,
  };

  beforeEach(() => {
    mockReadContract.mockResolvedValue(0n); // no Comet balances in these cases
  });

  it("backfills an unmatched Zerion deposit position above the dust threshold", async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma, [zerionDeposit]);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).toHaveBeenCalledTimes(1);
    const created = prisma.strategyPosition.create.mock.calls[0][0].data;
    expect(created.chainId).toBe(8453);
    expect(created.assetSymbol).toBe("USDC");
    expect(created.currentAmountUsd).toBe(5);
  });

  it("skips a Zerion position below the $1 dust threshold", async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma, [{ ...zerionDeposit, valueUsd: 0.5 }]);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).not.toHaveBeenCalled();
  });

  it("skips a Zerion position on a chain we don't map", async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma, [{ ...zerionDeposit, zerionChainId: "some-unmapped-chain" }]);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).not.toHaveBeenCalled();
  });

  it("never throws out of getPositions when Zerion itself fails", async () => {
    const prisma = fakePrisma();
    const zerionClient = { getPositions: jest.fn().mockRejectedValue(new Error("down")) };
    const serviceWithFailingZerion = new StrategiesService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      {} as any,
      {} as any,
      { getPricesByAddress: jest.fn(), getPricesBySymbol: jest.fn().mockResolvedValue(new Map()) } as any,
      zerionClient as any,
    );

    await expect(
      serviceWithFailingZerion.getPositions("user-1", WALLET),
    ).resolves.toEqual([]);
  });
});


describe("discoverVaultPositions (on-chain ERC-4626 scan where Zerion is blind)", () => {
  const VAULT = "0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const arcRow = {
    poolId: "arc-steakhouse",
    protocolSlug: "morpho-v1",
    chainId: ARC_CHAIN_ID,
    chainName: "Arc",
    assetSymbol: "USDC",
    tier: "balanced",
    depositTarget: { kind: "erc4626", vault: VAULT, asset: ARC_USDC },
  };
  // Ethereum is Zerion-indexed, so it must never be scanned here.
  const ethRow = { ...arcRow, poolId: "eth-x", chainId: 1, chainName: "Ethereum" };

  function arcChain(shares: bigint) {
    mockReadContract.mockImplementation(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === COMET) return 0n;
        if (address.toLowerCase() === VAULT && functionName === "balanceOf") return shares;
        if (address.toLowerCase() === VAULT && functionName === "convertToAssets") return 86_780_893n;
        if (address.toLowerCase() === ARC_USDC && functionName === "decimals") return 6;
        throw new Error(`unexpected call ${functionName} on ${address}`);
      },
    );
  }

  it("backfills a vault position the user opened outside Takumi, valued on-chain", async () => {
    arcChain(86_649_917_590_645_973_982n);
    const prisma = fakePrisma();
    prisma.opportunityCache.findMany.mockResolvedValue([arcRow, ethRow]);
    const service = makeService(prisma);

    await service.getPositions("user-1", WALLET);

    expect(prisma.strategyPosition.create).toHaveBeenCalledTimes(1);
    const created = prisma.strategyPosition.create.mock.calls[0][0].data;
    expect(created.protocolSlug).toBe("morpho-v1");
    expect(created.chainId).toBe(ARC_CHAIN_ID);
    expect(created.poolId).toBe("arc-steakhouse");
    expect(created.assetContract).toBe(ARC_USDC);
    expect(created.amountAtDeposit).toBe("86780893");
    // Only the Arc vault was read; the Zerion-covered chain was not.
    const vaultReads = mockReadContract.mock.calls.filter(
      ([c]) => (c as { address: string }).address.toLowerCase() === VAULT,
    );
    expect(vaultReads.length).toBe(2);
  });

  it("skips a vault the wallet does not hold, or one already tracked", async () => {
    arcChain(0n);
    const prisma = fakePrisma();
    prisma.opportunityCache.findMany.mockResolvedValue([arcRow]);
    await makeService(prisma).getPositions("user-1", WALLET);
    expect(prisma.strategyPosition.create).not.toHaveBeenCalled();

    arcChain(5n);
    const tracked = fakePrisma();
    tracked.opportunityCache.findMany.mockResolvedValue([arcRow]);
    tracked.strategyPosition.findMany.mockResolvedValue([
      {
        id: "p1",
        protocolSlug: "morpho-v1",
        chainId: ARC_CHAIN_ID,
        poolId: "arc-steakhouse",
        assetContract: ARC_USDC,
        status: "active",
      },
    ]);
    await makeService(tracked).getPositions("user-1", WALLET);
    expect(tracked.strategyPosition.create).not.toHaveBeenCalled();
  });
});
