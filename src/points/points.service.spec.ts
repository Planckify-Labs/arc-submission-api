import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ExchangeRateService } from "../exchange-rate/exchange-rate.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PointsCacheService } from "../valkey/services/points-cache.service";
import { PointsService } from "./points.service";

function buildHarness(
  opts: {
    user?: Record<string, unknown> | null;
    token?: Record<string, unknown> | null;
    blockchain?: Record<string, unknown> | null;
    contract?: Record<string, unknown> | null;
    priceConfig?: Record<string, unknown> | null;
    exchangeRate?: { rate: number } | null;
    balance?: { balance: bigint } | null;
    existingPointTx?: Record<string, unknown> | null;
    existingByHash?: Record<string, unknown> | null;
    existingJob?: Record<string, unknown> | null;
  } = {},
) {
  // createDeposit's lookups run inside its transaction; one implementation
  // serves both clients so either can be asserted on.
  const findPointTx = jest.fn(
    async ({ where }: { where: { txHash?: string; refId?: string } }) => {
      await Promise.resolve();
      if (where.txHash) return opts.existingByHash ?? null;
      return opts.existingPointTx ?? null;
    },
  );
  const txCalls = {
    pointBalance: {
      findUnique: jest.fn(async () => opts.balance ?? null),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
    pointTransaction: {
      findFirst: findPointTx,
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "ptx_1",
        createdAt: new Date(),
        metadata: null,
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    pointPriceConfig: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({ id: "pc_new" })),
    },
  };
  const tx: Record<string, unknown> = {
    $executeRaw: jest.fn(async () => 1),
    pointBalance: txCalls.pointBalance,
    pointTransaction: txCalls.pointTransaction,
    pointPriceConfig: txCalls.pointPriceConfig,
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    user: {
      findUnique: jest.fn(async () => opts.user ?? null),
      findMany: jest.fn(async () => []),
    },
    // Token rows default to the "cleared for payment" state so each test only
    // has to spell out the field it is actually exercising.
    token: {
      findUnique: jest.fn(async () =>
        opts.token ? { isPaymentEnabled: true, ...opts.token } : null,
      ),
    },
    blockchain: { findUnique: jest.fn(async () => opts.blockchain ?? null) },
    smartContract: { findFirst: jest.fn(async () => opts.contract ?? null) },
    pointPriceConfig: {
      findFirst: jest.fn(async () => opts.priceConfig ?? null),
    },
    pointBalance: { findUnique: jest.fn(async () => opts.balance ?? null) },
    pointTransaction: {
      findFirst: findPointTx,
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "ptx_top",
        createdAt: new Date(),
        ...data,
      })),
      aggregate: jest.fn(async () => ({ _sum: { amount: BigInt(0) } })),
    },
    walletAccountLink: { findMany: jest.fn(async () => []) },
  } as unknown as PrismaService;

  const exchangeRateService = {
    findLatest: jest.fn(async () => opts.exchangeRate ?? null),
  } as unknown as ExchangeRateService;

  const pointsCache = {
    getPointPrice: jest.fn(
      async (_t: string, _c: string, fallback: () => unknown) => fallback(),
    ),
    getPointConfig: jest.fn(async (_c: string, fallback: () => unknown) =>
      fallback(),
    ),
    getPointBalance: jest.fn(async (_u: string, fallback: () => unknown) =>
      fallback(),
    ),
    invalidateBalance: jest.fn(async () => undefined),
    invalidateConfig: jest.fn(async () => undefined),
    invalidatePrices: jest.fn(async () => undefined),
  } as unknown as PointsCacheService;

  const queue = {
    add: jest.fn(async () => ({ id: "job_1" })),
    getJob: jest.fn(async () => opts.existingJob ?? null),
  } as unknown as Queue;

  const svc = new PointsService(
    prisma,
    exchangeRateService,
    pointsCache,
    queue,
  );
  return { svc, prisma, queue, pointsCache, exchangeRateService, txCalls, tx };
}

describe("PointsService.getPointPrice", () => {
  it("rejects when token missing", async () => {
    const { svc } = buildHarness({ token: null });
    await expect(
      svc.getPointPrice({ tokenId: "tk_x", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects inactive or non-stablecoin token", async () => {
    const { svc: svcInactive } = buildHarness({
      token: { isActive: false, isStablecoin: true, symbol: "X" },
    });
    await expect(
      svcInactive.getPointPrice({ tokenId: "tk_x", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const { svc: svcNonStable } = buildHarness({
      token: { isActive: true, isStablecoin: false, symbol: "X" },
    });
    await expect(
      svcNonStable.getPointPrice({ tokenId: "tk_x", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a token ops has not enabled for payments", async () => {
    // `isPaymentEnabled` is the switch that decides which chains offer
    // Add Points at all — quoting must not go around the token list.
    const { svc } = buildHarness({
      token: {
        isActive: true,
        isStablecoin: true,
        isPaymentEnabled: false,
        symbol: "IDRX",
        peggedCurrency: "IDR",
      },
      priceConfig: { baseRate: "1" },
    });
    await expect(
      svc.getPointPrice({ tokenId: "tk_idrx", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects when no priceConfig is active for the currency", async () => {
    const { svc } = buildHarness({
      token: { isActive: true, isStablecoin: true, symbol: "USDC" },
      priceConfig: null,
    });
    await expect(
      svc.getPointPrice({ tokenId: "tk_x", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uses 1:1 rate when token is pegged to the requested currency", async () => {
    const { svc, exchangeRateService } = buildHarness({
      token: {
        id: "tk_idrx",
        isActive: true,
        isStablecoin: true,
        symbol: "IDRX",
        peggedCurrency: "IDR",
        decimals: 6,
        name: "IDRX",
      },
      priceConfig: { baseRate: "1" },
    });
    const out = await svc.getPointPrice({
      tokenId: "tk_idrx",
      currency: "IDR",
    });
    expect(exchangeRateService.findLatest).not.toHaveBeenCalled();
    expect(out.token.symbol).toBe("IDRX");
    expect(out.minimumPoints).toBe(15_000);
  });

  it("rejects when no exchange rate is available for non-pegged token", async () => {
    const { svc } = buildHarness({
      token: {
        isActive: true,
        isStablecoin: true,
        symbol: "USDC",
        peggedCurrency: "USD",
      },
      priceConfig: { baseRate: "1" },
      exchangeRate: null,
    });
    await expect(
      svc.getPointPrice({ tokenId: "tk_usdc", currency: "IDR" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("PointsService.getBalance", () => {
  it("returns '0' when no balance row exists", async () => {
    const { svc } = buildHarness({ balance: null });
    const out = await svc.getBalance("u1");
    expect(out).toEqual({ userId: "u1", balance: "0" });
  });

  it("returns the balance as a string", async () => {
    const { svc } = buildHarness({ balance: { balance: BigInt(123_456) } });
    const out = await svc.getBalance("u1");
    expect(out.balance).toBe("123456");
  });
});

const validRefs = {
  token: {
    isActive: true,
    isStablecoin: true,
    symbol: "IDRX",
    peggedCurrency: "IDR",
  },
  blockchain: { isActive: true },
  contract: { id: "sc_1", isActive: true },
  priceConfig: { baseRate: "1" },
};

describe("PointsService.createDeposit input validation", () => {
  const dto = {
    refId: "ref_1",
    walletAddress: "0xUSER",
    txHash: "0xhash",
    tokenId: "tk_1",
    blockchainId: "bc_1",
    contractAddress: "0xCONTRACT",
    tokenAmount: "100",
    currency: "IDR",
  };

  it("404s when user missing", async () => {
    const { svc } = buildHarness({ user: null });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects when wallet doesn't match user's wallet", async () => {
    const { svc } = buildHarness({
      user: { id: "u1", walletAddress: "0xOTHER" },
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a payer that is only a linked address", async () => {
    // Links are self-asserted (POST /auth/google/wallets takes no proof), and
    // refIds are public on-chain — accepting a link let anyone claim a
    // stranger's deposit by linking the stranger's address first.
    const { svc, prisma } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
    });
    await expect(
      svc.createDeposit("u1", { ...dto, walletAddress: "GVICTIM" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.walletAccountLink.findMany).not.toHaveBeenCalled();
  });

  it("rejects when this user already used the txHash for another deposit (409)", async () => {
    const { svc, txCalls } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
      existingByHash: { status: "PENDING" },
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Scoped to the caller — another user submitting this hash must not be
    // able to lock the real payer out.
    expect(txCalls.pointTransaction.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: "u1", txHash: "0xhash" }),
    });
  });

  it("writes nothing when validation fails after the user already paid", async () => {
    // A non-pegged token with no exchange rate: the old flow had already
    // claimed the refId by this point, so the retry dead-ended forever.
    const { svc, prisma, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      token: {
        isActive: true,
        isStablecoin: true,
        symbol: "USDT",
        peggedCurrency: "USD",
      },
      blockchain: { isActive: true },
      contract: { id: "sc_1", isActive: true },
      priceConfig: { baseRate: "1" },
      exchangeRate: null,
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects bad token (not active / not stablecoin)", async () => {
    const { svc } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      token: { isActive: false, isStablecoin: true, symbol: "USDC" },
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a token ops has not enabled for payments", async () => {
    // Server-side enforcement of the same gate mobile filters its token list
    // on — a client that skips that list must not be able to deposit an
    // unswitched-on token.
    const { svc, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      token: {
        isActive: true,
        isStablecoin: true,
        isPaymentEnabled: false,
        symbol: "IDRX",
        peggedCurrency: "IDR",
      },
      blockchain: { isActive: true },
      contract: { id: "sc_1", isActive: true },
      priceConfig: { baseRate: "1" },
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Rejected at intake: nothing queued for on-chain verification.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects bad blockchain", async () => {
    const { svc } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      token: {
        isActive: true,
        isStablecoin: true,
        symbol: "USDC",
        peggedCurrency: "USD",
      },
      blockchain: { isActive: false },
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when smart contract not found / not active", async () => {
    const { svc } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      token: {
        isActive: true,
        isStablecoin: true,
        symbol: "USDC",
        peggedCurrency: "USD",
      },
      blockchain: { isActive: true },
      contract: null,
    });
    await expect(svc.createDeposit("u1", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("PointsService.createDeposit happy path", () => {
  const dto = {
    refId: "ref_h",
    walletAddress: "0xUSER",
    txHash: "0xhash_h",
    tokenId: "tk_1",
    blockchainId: "bc_1",
    contractAddress: "0xCONTRACT",
    tokenAmount: "100",
    currency: "IDR",
  };

  it("creates a PENDING PointTransaction under the deposit lock and enqueues verify-deposit", async () => {
    const { svc, txCalls, tx, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
    });
    const out = await svc.createDeposit("u1", dto as never);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(txCalls.pointTransaction.create).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "verify-deposit",
      expect.objectContaining({ pointTransactionId: "ptx_1" }),
      // Long, capped schedule from settlement-policy: our own outages
      // only delay a deposit, they never fail it. Keyed by row so it is
      // added once.
      expect.objectContaining({
        attempts: 150,
        backoff: { type: "custom" },
        jobId: "point-deposit-ptx_1",
      }),
    );
    expect(out.status).toBe("PENDING");
  });

  it("accepts a non-EVM payer that is the session wallet itself", async () => {
    // Stellar / Solana wallets sign in with their own SIWS session, so the
    // session user's walletAddress IS the G-address — no link needed.
    const { svc, txCalls } = buildHarness({
      user: { id: "u1", walletAddress: "GSTELLARPAYER" },
      ...validRefs,
    });
    const out = await svc.createDeposit("u1", {
      ...dto,
      walletAddress: "GSTELLARPAYER",
    } as never);
    expect(out.status).toBe("PENDING");
    expect(txCalls.pointTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ walletAddress: "GSTELLARPAYER" }),
      }),
    );
  });
});

describe("PointsService.createDeposit idempotency", () => {
  const dto = {
    refId: "ref_i",
    walletAddress: "0xUSER",
    txHash: "0xhash_i",
    tokenId: "tk_1",
    blockchainId: "bc_1",
    contractAddress: "0xCONTRACT",
    tokenAmount: "100",
    currency: "IDR",
  };
  const existing = {
    id: "ptx_old",
    status: "PENDING",
    createdAt: new Date("2026-10-23T00:00:00Z"),
    metadata: null,
  };

  it("returns the caller's own row for a retried deposit instead of a second one", async () => {
    const { svc, txCalls } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
      existingPointTx: existing,
      existingJob: { id: "point-deposit-ptx_old" },
    });
    const out = await svc.createDeposit("u1", dto as never);
    expect(out).toEqual(
      expect.objectContaining({ id: "ptx_old", status: "PENDING" }),
    );
    expect(out.message).toMatch(/already submitted/i);
    expect(txCalls.pointTransaction.create).not.toHaveBeenCalled();
  });

  it("only treats the caller's own rows as the existing submission", async () => {
    // Another user's row for the same refId can never be credited — the
    // worker checks the on-chain payer — so it must not block the real payer.
    const { svc, txCalls } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
    });
    await svc.createDeposit("u1", dto as never);
    expect(txCalls.pointTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          refId: "ref_i",
          blockchainId: "bc_1",
          contractAddress: { equals: "0xCONTRACT", mode: "insensitive" },
        }),
      }),
    );
  });

  it("re-enqueues a retried PENDING row whose job never got added", async () => {
    const { svc, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
      existingPointTx: existing,
      existingJob: null,
    });
    await svc.createDeposit("u1", dto as never);
    expect(queue.add).toHaveBeenCalledWith(
      "verify-deposit",
      expect.objectContaining({ pointTransactionId: "ptx_old" }),
      expect.objectContaining({ jobId: "point-deposit-ptx_old" }),
    );
  });

  it("does not re-enqueue a retried row that still has its job", async () => {
    const { svc, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
      existingPointTx: existing,
      existingJob: { id: "point-deposit-ptx_old" },
    });
    await svc.createDeposit("u1", dto as never);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not re-open a row already handed to ops", async () => {
    const { svc, queue } = buildHarness({
      user: { id: "u1", walletAddress: "0xUSER" },
      ...validRefs,
      existingPointTx: { ...existing, metadata: { needsReview: true } },
    });
    await svc.createDeposit("u1", dto as never);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe("PointsService.deductPoints", () => {
  it("rejects with 400 when balance is insufficient", async () => {
    const { svc } = buildHarness({
      balance: { balance: BigInt(100) },
    });
    await expect(
      svc.deductPoints({
        userId: "u1",
        amount: BigInt(500),
        referenceType: "PURCHASE",
        referenceId: "pur_x",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("decrements balance, writes a SPEND tx and invalidates cache", async () => {
    const { svc, txCalls, pointsCache } = buildHarness({
      balance: { balance: BigInt(1000) },
    });
    await svc.deductPoints({
      userId: "u1",
      amount: BigInt(300),
      referenceType: "PURCHASE",
      referenceId: "pur_x",
    });
    expect(txCalls.pointBalance.update).toHaveBeenCalled();
    expect(txCalls.pointTransaction.create).toHaveBeenCalled();
    expect(pointsCache.invalidateBalance).toHaveBeenCalledWith("u1");
  });

  it("creates a balance row when none exists yet", async () => {
    const { svc, txCalls } = buildHarness({ balance: null });
    await expect(
      svc.deductPoints({
        userId: "u1",
        amount: BigInt(0),
        referenceType: "X",
        referenceId: "y",
      }),
    ).resolves.toBeUndefined();
    // 0 amount → balance condition (0 < 0) false → succeeds; ensure path used.
    expect(txCalls.pointBalance.findUnique).toHaveBeenCalled();
  });
});

describe("PointsService.getDepositStatus", () => {
  it("404s when deposit not owned by user / not found", async () => {
    const { svc } = buildHarness();
    await expect(
      svc.getDepositStatus("u1", "ptx_missing"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PointsService.updatePriceConfig", () => {
  it("deactivates old configs, inserts the new active one and invalidates cache", async () => {
    const { svc, prisma, pointsCache } = buildHarness();
    await svc.updatePriceConfig("IDR", "1", "admin_1");
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(pointsCache.invalidateConfig).toHaveBeenCalledWith("IDR");
    expect(pointsCache.invalidatePrices).toHaveBeenCalled();
  });
});
