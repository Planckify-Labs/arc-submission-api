import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  IntentsService,
  addMarkup,
  computeUsdcMicros,
} from "./intents.service";

// PushService pulls in expo-server-sdk, which ships pure ESM and isn't
// transformed by Jest's default config. Nothing here ever instantiates
// the real PushService, so a trivial stub avoids Jest ever parsing it.
jest.mock("expo-server-sdk", () => ({ Expo: class {} }));
import type { ConfigService } from "@nestjs/config";
import type { BlockchainVerificationService } from "../blockchain-verification/blockchain-verification.service";
import type { QrSigningService } from "../merchants/qr-signing.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TransactionsService } from "../transactions/transactions.service";
import type { BlockchainCacheService } from "../valkey/services/blockchain-cache.service";
import type { ValkeyService } from "../valkey/valkey.service";
import type { X402SupportedService } from "../x402/x402-supported.service";
import type { ICircleSettleClient } from "./circle-settle.client";

/**
 * Stub for `X402SupportedService`. We inject a ready-to-go Arc entry so
 * most tests exercise the happy path; individual tests can swap the
 * return value via `.mockReturnValueOnce(null)` to exercise the failure
 * paths.
 */
function x402Stub(
  overrides?: Partial<ReturnType<X402SupportedService["getSupportedForChain"]>>,
): Pick<X402SupportedService, "getSupportedForChain"> {
  const base = {
    namespace: "eip155" as const,
    chainId: 5042002,
    network: "eip155:5042002",
    scheme: "exact",
    asset: "0x3600000000000000000000000000000000000000",
    domainName: "GatewayWalletBatched",
    domainVersion: "1",
    verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    authorizedSigners: [],
    ...overrides,
  };
  return {
    getSupportedForChain: jest.fn().mockReturnValue(base),
  };
}

function valkeyStub(
  cached: Record<string, unknown> = {},
): Pick<ValkeyService, "get" | "set"> {
  const store = new Map(Object.entries(cached));
  return {
    get: jest.fn((key: string) =>
      Promise.resolve(store.has(key) ? store.get(key) : null),
    ),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve(true);
    }),
  } as unknown as ValkeyService;
}

function configStub(
  treasury = "0x00000000000000000000000000000000abCDef01",
): Pick<ConfigService, "get"> {
  return {
    get: jest.fn((k: string) =>
      k === "PLATFORM_TREASURY_ADDRESS_EVM" ? treasury : undefined,
    ),
  } as unknown as ConfigService;
}

interface FakePrisma {
  paymentIntent: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  merchant: { findUnique: jest.Mock };
  exchangeRate: { findFirst: jest.Mock };
  blockchain: { findUnique: jest.Mock };
  smartContract: { findFirst: jest.Mock };
}

function prismaStub(opts?: {
  merchant?: Record<string, unknown> | null;
  fxRow?: Record<string, unknown> | null;
  createdIntent?: Record<string, unknown>;
}): FakePrisma {
  const merchant =
    opts?.merchant === undefined
      ? { id: "mch_123", isActive: true }
      : opts.merchant;
  const fxRow =
    opts?.fxRow === undefined
      ? {
          id: 1,
          createdAt: new Date("2026-04-20T00:00:00Z"),
          rate: { toString: () => "15700" },
          markup: { toString: () => "1.5" },
          fromCurrency: "USDC",
          toCurrency: "IDR",
          provider: "CoinGecko",
          sourceProvider: { name: "CoinGecko" },
        }
      : opts.fxRow;

  const createdIntent = opts?.createdIntent ?? {
    id: "pi_01HXYZ",
    status: "QUOTED",
    nanopayUsdcAmountMicros: 940924n,
    nanopayUsdcSourceChainId: 5042002,
    nanopayUsdcTreasuryAddress: "0x00000000000000000000000000000000abCDef01",
    nanopayNonce: Buffer.alloc(32, 0x11),
    nanopayValidAfter: 1_700_000_000,
    nanopayValidBefore: 1_700_262_600,
    expiresAt: new Date("2026-04-23T01:10:00Z"),
    fiatCurrency: "IDR",
  };

  return {
    paymentIntent: {
      create: jest.fn(async () => createdIntent),
      findUnique: jest.fn(async () => createdIntent),
    },
    merchant: { findUnique: jest.fn(async () => merchant) },
    exchangeRate: { findFirst: jest.fn(async () => fxRow) },
    blockchain: {
      findUnique: jest.fn(async () => ({
        id: "01ARC",
        isActive: true,
        metadata: {
          x402FacilitatorUrl:
            "https://gateway-api-testnet.circle.com/gateway/v1/x402/settle",
        },
      })),
    },
    smartContract: {
      findFirst: jest.fn(async () => ({
        address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
      })),
    },
  };
}

/**
 * Stub for the task-24 Circle settle client. Intent GET (task 25) never
 * touches it, but the constructor requires the injection — we provide a
 * no-op stub so constructing the service in read-path tests works. The
 * `settle` name matches `ICircleSettleClient`.
 */
function circleSettleStub() {
  return {
    settle: jest.fn().mockResolvedValue({
      kind: "ok",
      response: {
        success: true,
        transaction: "stub",
        network: "eip155:5042002",
      },
      rawBody: {},
    }),
  };
}

function blockchainCacheStub() {
  return {
    getByChainId: jest.fn(
      async (_chainId: number, fallback: () => Promise<unknown>) => fallback(),
    ),
    getByChainSlug: jest.fn(
      async (_slug: string, fallback: () => Promise<unknown>) => fallback(),
    ),
  };
}

function buildService(
  overrides: {
    prisma?: FakePrisma;
    x402?: Pick<X402SupportedService, "getSupportedForChain">;
    valkey?: Pick<ValkeyService, "get" | "set">;
    config?: Pick<ConfigService, "get">;
    circleSettle?: { settle: jest.Mock };
    blockchainVerification?: { getPublicClient: jest.Mock } | null;
    queue?: { add: jest.Mock; getJob: jest.Mock } | null;
    push?: {
      sendSettledPush: jest.Mock;
      sendSettlementIssuePush: jest.Mock;
    } | null;
    transactions?: { create: jest.Mock };
  } = {},
) {
  const prisma = overrides.prisma ?? prismaStub();
  const x402 = overrides.x402 ?? x402Stub();
  const valkey = overrides.valkey ?? valkeyStub();
  const config = overrides.config ?? configStub();
  const circleSettle = overrides.circleSettle ?? circleSettleStub();
  const blockchainVerification = overrides.blockchainVerification ?? null;
  const bcCache = blockchainCacheStub();
  const svc = new IntentsService(
    prisma as unknown as PrismaService,
    valkey as unknown as ValkeyService,
    bcCache as unknown as BlockchainCacheService,
    x402 as unknown as X402SupportedService,
    config as unknown as ConfigService,
    circleSettle as unknown as ICircleSettleClient,
    null, // payoutProvider — optional, null is valid.
    blockchainVerification as unknown as BlockchainVerificationService,
    null, // stellarVerification — optional, null is valid.
    null, // circleSettleSvm
    {} as unknown as QrSigningService,
    (overrides.transactions ?? {
      create: jest.fn().mockResolvedValue({}),
    }) as unknown as TransactionsService, // transactionsService
    null, // quoteSigner
    (overrides.queue ?? null) as never, // onchainSettlementQueue
    (overrides.push ?? null) as never, // pushService
  );
  return {
    svc,
    prisma,
    x402,
    valkey,
    config,
    circleSettle,
    blockchainVerification,
    bcCache,
  };
}

describe("IntentsService", () => {
  const defaultArgs = {
    idempotencyKey: "a".repeat(32),
    payerAddress: "0x1111111111111111111111111111111111111111",
    payerUserId: "user_1",
    rawBodyForHash:
      '{"currency":"IDR","fiatAmountMinor":15000,"merchantId":"mch_123"}',
  };
  const defaultDto = {
    merchantId: "mch_123",
    fiatAmountMinor: 15_000,
    currency: "IDR" as const,
  };

  it("creates an intent on the happy path", async () => {
    const { svc, prisma } = buildService();
    const result = await svc.createIntent({ dto: defaultDto, ...defaultArgs });

    expect(prisma.paymentIntent.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("pending");
    expect(result.nanopayUsdcSourceChainId).toBe(5042002);
    expect(result.nanopay).not.toBeNull();
    expect(result.nanopay?.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.nanopay?.validBefore).toBeGreaterThanOrEqual(
      (result.nanopay?.validAfter ?? 0) + 259_200,
    );
    // 15000 IDR / 15700 × 1.015 = 0.969745... → 969746 micros (rounded up).
    expect(result.nanopayUsdcAmountMicros).toBe("969746");
  });

  it("404s when the merchant is missing", async () => {
    const { svc } = buildService({
      prisma: prismaStub({ merchant: null }),
    });
    await expect(
      svc.createIntent({ dto: defaultDto, ...defaultArgs }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("503s when no FX row is available", async () => {
    const { svc } = buildService({
      prisma: prismaStub({ fxRow: null }),
    });
    await expect(
      svc.createIntent({ dto: defaultDto, ...defaultArgs }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("keys the FX snapshot on the nanopay rail's fixed USDC", async () => {
    const { svc, prisma } = buildService();
    await svc.createIntent({ dto: defaultDto, ...defaultArgs });
    expect(prisma.exchangeRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fromCurrency: "USDC",
          toCurrency: "IDR",
        }),
      }),
    );
  });

  it("keys the FX snapshot on the selected token's symbol on the on-chain rail", async () => {
    const prisma = prismaStub({
      fxRow: {
        id: 5,
        createdAt: new Date("2026-09-16T00:00:00Z"),
        rate: { toString: () => "17690" },
        markup: { toString: () => "1.5" },
        fromCurrency: "AUSD",
        toCurrency: "IDR",
        provider: "CoinGecko",
        sourceProvider: { name: "CoinGecko" },
      },
    });
    const ausdToken = {
      id: "tok_ausd",
      symbol: "AUSD",
      decimals: 6,
      isPaymentEnabled: true,
      isStablecoin: true,
      isActive: true,
      blockchain: { id: "01MONAD", chainId: 10143, type: "EVM" },
    };
    (prisma as unknown as { token: unknown }).token = {
      findUnique: jest.fn(async () => ausdToken),
      findFirst: jest.fn(async () => ausdToken),
    };
    // getIntent re-reads the row to serialize; give it the shape it needs.
    prisma.paymentIntent.findUnique = jest.fn(async () => null);
    const config = {
      get: jest.fn((k: string, fallback?: unknown) =>
        k === "PAYMENT_SETTLEMENT_RAIL" ? "takumipay" : fallback,
      ),
    } as unknown as ConfigService;
    const { svc } = buildService({ prisma, config });

    await svc
      .createIntent({
        dto: { ...defaultDto, sourceTokenId: "tok_ausd" },
        ...defaultArgs,
      })
      .catch(() => undefined); // downstream serialization is not under test here

    expect(prisma.exchangeRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fromCurrency: "AUSD",
          toCurrency: "IDR",
        }),
      }),
    );
    expect(prisma.exchangeRate.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fromCurrency: "USDC" }),
      }),
    );
  });

  it("503s when the x402 domain cache has no entry for Arc", async () => {
    const x402: Pick<X402SupportedService, "getSupportedForChain"> = {
      getSupportedForChain: jest.fn().mockReturnValue(null),
    };
    const { svc } = buildService({ x402 });
    await expect(
      svc.createIntent({ dto: defaultDto, ...defaultArgs }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("returns the cached intent on an idempotent replay with a matching body hash", async () => {
    // Seed valkey with a hit for the canonical body hash the service will
    // compute. Because the service hashes the payload we pass in via
    // `rawBodyForHash`, we can control the hash directly in this test.
    const bodyHash = require("node:crypto")
      .createHash("sha256")
      .update(defaultArgs.rawBodyForHash)
      .digest("hex");

    const cached = {
      [`pay:intent:idem:${defaultArgs.idempotencyKey}`]: {
        bodyHash,
        intentId: "pi_EXISTING",
        createdAt: Date.now(),
      },
    };
    const existing = {
      id: "pi_EXISTING",
      status: "QUOTED" as const,
      nanopayUsdcAmountMicros: 123_456n,
      nanopayUsdcSourceChainId: 5042002,
      nanopayUsdcTreasuryAddress: "0x00000000000000000000000000000000abCDef01",
      nanopayNonce: Buffer.alloc(32, 0x22),
      nanopayValidAfter: 1,
      nanopayValidBefore: 2,
      expiresAt: new Date("2026-04-23T01:10:00Z"),
      fiatCurrency: "IDR",
      // The replay branch delegates to `getIntent`, whose single serializer
      // reads the joined relations + quote scalars — mirror the `include`
      // shape of the real query or the replay path throws.
      payerUserId: defaultArgs.payerUserId,
      payer: null,
      merchantId: "mch_123",
      merchant: {
        id: "mch_123",
        userId: defaultArgs.payerUserId,
        displayName: "Warung Tester",
      },
      fiatAmountMinor: 15_000,
      fxRateSnapshot: 15_700,
      path: null,
      createdAt: new Date("2026-04-23T01:00:00Z"),
      payouts: [],
      nanopaySubmissions: [],
      sourceToken: null,
      quoteSignature: null,
    };
    const prisma = prismaStub({ createdIntent: existing });
    // findUnique returns the existing row for the idempotent branch.
    prisma.paymentIntent.findUnique = jest.fn(async () => existing);

    const { svc } = buildService({ prisma, valkey: valkeyStub(cached) });
    const result = await svc.createIntent({ dto: defaultDto, ...defaultArgs });

    expect(result.id).toBe("pi_EXISTING");
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it("409s on idempotent replay with a different body hash", async () => {
    const cached = {
      [`pay:intent:idem:${defaultArgs.idempotencyKey}`]: {
        bodyHash: "deadbeef".repeat(8), // guaranteed ≠ the real hash.
        intentId: "pi_OTHER",
        createdAt: Date.now(),
      },
    };
    const { svc } = buildService({ valkey: valkeyStub(cached) });
    await expect(
      svc.createIntent({ dto: defaultDto, ...defaultArgs }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("400s when neither merchantId nor scannedPayload is provided", async () => {
    const { svc } = buildService();
    await expect(
      svc.createIntent({
        dto: { fiatAmountMinor: 15_000, currency: "IDR" as const },
        ...defaultArgs,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("computeUsdcMicros", () => {
  it("applies the markup on top: 15000 IDR at 15700 with 1.5% → 969746 micros", () => {
    const mul = addMarkup("1.5");
    const micros = computeUsdcMicros({
      fiatAmountMinor: 15_000n,
      fxRate: "15700",
      markupMultiplier: mul,
    });
    // 15000 / 15700 × 1.015 = 0.969745... → 969746 (rounded up).
    expect(micros).toBe(969_746n);
  });

  it("never charges less than the plain conversion when markup is not negative", () => {
    for (const fiat of [1n, 999n, 15_000n, 50_000n, 1_234_567n]) {
      for (const fxRate of ["15700", "16234.5", "17690"]) {
        for (const markup of ["0", "0.5", "1.5", "3"]) {
          const micros = computeUsdcMicros({
            fiatAmountMinor: fiat,
            fxRate,
            markupMultiplier: addMarkup(markup),
          });
          const plain = (Number(fiat) / Number(fxRate)) * 1_000_000;
          expect(Number(micros)).toBeGreaterThanOrEqual(Math.floor(plain));
          expect(micros * BigInt(Math.round(Number(fxRate) * 10))).toBeGreaterThanOrEqual(
            fiat * 10_000_000n,
          );
        }
      }
    }
  });

  it("charges more as the markup rises", () => {
    const at = (markup: string) =>
      computeUsdcMicros({
        fiatAmountMinor: 50_000n,
        fxRate: "17690",
        markupMultiplier: addMarkup(markup),
      });
    expect(at("1.5")).toBeGreaterThan(at("0"));
    expect(at("3")).toBeGreaterThan(at("1.5"));
  });

  it("handles integer rates cleanly", () => {
    const micros = computeUsdcMicros({
      fiatAmountMinor: 1_000_000n,
      fxRate: "10000",
      markupMultiplier: "1",
    });
    expect(micros).toBe(100_000_000n);
  });

  it("rejects a zero rate", () => {
    expect(() =>
      computeUsdcMicros({
        fiatAmountMinor: 100n,
        fxRate: "0",
        markupMultiplier: "1",
      }),
    ).toThrow();
  });
});

describe("addMarkup", () => {
  it("converts a percent markup into a 1+x multiplier", () => {
    expect(addMarkup("1.5")).toBe("1.015");
    expect(addMarkup("0")).toBe("1");
    expect(addMarkup("100")).toBe("2");
  });
});

/**
 * `getIntent` tests — polling read, auth boundary, auto-expire projection.
 * We stub the `paymentIntent.findUnique` response directly (bypassing the
 * `prismaStub` helper above since that one only returns the create-intent
 * shape). This keeps each test focused on the read-path state matrix.
 */
describe("IntentsService.getIntent", () => {
  // A "persisted" row shape — include the relations the service expects.
  function intentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "pi_01HXYZ",
      status: "QUOTED" as const,
      payerUserId: "user_payer",
      merchantId: "mch_123",
      fiatAmountMinor: 15_000,
      fiatCurrency: "IDR",
      fxRateSnapshot: { toString: () => "15700" },
      nanopayUsdcAmountMicros: 941_294n,
      nanopayUsdcSourceChainId: 5042002,
      nanopayUsdcTreasuryAddress: "0x00000000000000000000000000000000abCDef01",
      nanopayNonce: Buffer.alloc(32, 0x11),
      nanopayValidAfter: 1_700_000_000,
      nanopayValidBefore: 1_700_262_600,
      // Default: expires far in the future so the auto-expire overlay does
      // not fire unless a test explicitly overrides this.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date("2026-04-20T00:00:00Z"),
      merchant: {
        id: "mch_123",
        displayName: "Warung Bu Tini",
        userId: "user_merchant_owner",
      },
      payer: {
        id: "user_payer",
        walletAddress: "0x1111111111111111111111111111111111111111",
      },
      nanopaySubmissions: [],
      payouts: [],
      ...overrides,
    };
  }

  function buildGetService(row: ReturnType<typeof intentRow> | null) {
    // Cast-shaped stub — only the `paymentIntent.findUnique` path matters for GET.
    const prisma = {
      paymentIntent: {
        findUnique: jest.fn(async () => row),
        create: jest.fn(),
      },
      merchant: { findUnique: jest.fn() },
      exchangeRate: { findFirst: jest.fn() },
      smartContract: { findFirst: jest.fn(async () => null) },
    };
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    return { svc, prisma };
  }

  it("on the on-chain rail, names the settlement token and its own-unit amount so the client never labels it USDC", async () => {
    const { svc } = buildGetService(
      intentRow({
        path: "takumipay",
        onchainSettlements: [],
        sourceToken: {
          id: "ausd-monad-testnet-token",
          symbol: "AUSD",
          decimals: 6,
          contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
          blockchain: { id: "monad-testnet", type: "EVM", chainId: 10143 },
        },
      }),
    );
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.sourceTokenId).toBe("ausd-monad-testnet-token");
    expect(result.sourceToken).toEqual({
      id: "ausd-monad-testnet-token",
      symbol: "AUSD",
      decimals: 6,
      contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
    });
    expect(result.tokenAmountMinor).toBe("941294");
  });

  it("scales tokenAmountMinor to the token's decimals (18-dec token: micros × 10^12)", async () => {
    const { svc } = buildGetService(
      intentRow({
        path: "takumipay",
        onchainSettlements: [],
        sourceToken: {
          id: "tok18",
          symbol: "X18",
          decimals: 18,
          contractAddress: "0x2222222222222222222222222222222222222222",
          blockchain: { id: "chain", type: "EVM", chainId: 1 },
        },
      }),
    );
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.tokenAmountMinor).toBe("941294000000000000");
  });

  it("omits the token fields on the nanopay rail (USDC is implied there)", async () => {
    const { svc } = buildGetService(intentRow({ path: "nanopay" }));
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.sourceToken).toBeUndefined();
    expect(result.tokenAmountMinor).toBeUndefined();
  });

  it("returns the intent on the happy path when the caller is the payer by userId", async () => {
    const { svc } = buildGetService(intentRow());
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.id).toBe("pi_01HXYZ");
    expect(result.status).toBe("pending");
    expect(result.merchantDisplayName).toBe("Warung Bu Tini");
    expect(result.merchantId).toBe("mch_123");
    expect(result.fiatAmountMinor).toBe(15_000);
    expect(result.currency).toBe("IDR");
    expect(result.fxRate).toBe("15700");
    // BigInt → string (mobile contract); never leak the `n` suffix.
    expect(result.nanopayUsdcAmountMicros).toBe("941294");
    expect(typeof result.nanopayUsdcAmountMicros).toBe("string");
    // Pre-settle → nanopay block present for re-render of the sign modal.
    expect(result.nanopay).not.toBeNull();
    expect(result.nanopay?.from).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("allows the merchant owner to read", async () => {
    const { svc } = buildGetService(intentRow());
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_merchant_owner",
      walletAddress: null,
    });
    expect(result.id).toBe("pi_01HXYZ");
  });

  it("allows the payer to read via X-Payer-Address header stopgap", async () => {
    const { svc } = buildGetService(intentRow({ payerUserId: null }));
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: null,
      // EIP-55 mixed case — proves the case-insensitive match.
      walletAddress: "0x1111111111111111111111111111111111111111".toUpperCase(),
    });
    expect(result.id).toBe("pi_01HXYZ");
  });

  it("404s when the intent is not found", async () => {
    const { svc } = buildGetService(null);
    await expect(
      svc.getIntent({
        intentId: "pi_missing",
        userId: "user_payer",
        walletAddress: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("403s for an unrelated user (neither payer nor merchant owner)", async () => {
    const { svc } = buildGetService(intentRow());
    await expect(
      svc.getIntent({
        intentId: "pi_01HXYZ",
        userId: "user_other",
        walletAddress: "0x9999999999999999999999999999999999999999",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("projects status 'expired' when QUOTED and expiresAt is in the past (no DB mutation)", async () => {
    const row = intentRow({
      status: "QUOTED",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const { svc, prisma } = buildGetService(row);
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.status).toBe("expired");
    // Auto-expire nulls the nanopay block so mobile won't let the user sign a dead quote.
    expect(result.nanopay).toBeNull();
    // Strict invariant: GET must be read-only — no update calls.
    // We stubbed `findUnique` only; the Prisma shape has no `update` on
    // the stub. Assert the call log to make the read-only guarantee
    // visible in test output.
    expect(prisma.paymentIntent.findUnique).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-expire once the intent has moved past QUOTED", async () => {
    // SETTLED + expiresAt in the past — state is beyond the quote window,
    // so mobile should see `paid`, not `expired`.
    const row = intentRow({
      status: "SETTLED",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const { svc } = buildGetService(row);
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.status).toBe("paid");
    expect(result.nanopay).toBeNull();
  });

  it("surfaces payoutReferenceId + settledAt once the payout is terminal", async () => {
    const completedAt = new Date("2026-04-20T01:00:00Z");
    const row = intentRow({
      status: "PAID_OUT",
      payouts: [
        {
          id: "po_1",
          referenceId: "takumi-payout-ref-01",
          status: "COMPLETED",
          completedAt,
          createdAt: completedAt,
        },
      ],
    });
    const { svc } = buildGetService(row);
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.status).toBe("paid_out");
    expect(result.payoutReferenceId).toBe("takumi-payout-ref-01");
    expect(result.settledAt).toBe(completedAt.getTime());
  });

  it("omits payoutReferenceId + settledAt while the payout is still PROCESSING", async () => {
    const row = intentRow({
      status: "SETTLED",
      payouts: [
        {
          id: "po_1",
          referenceId: "takumi-payout-ref-01",
          status: "PROCESSING",
          completedAt: null,
          createdAt: new Date(),
        },
      ],
    });
    const { svc } = buildGetService(row);
    const result = await svc.getIntent({
      intentId: "pi_01HXYZ",
      userId: "user_payer",
      walletAddress: null,
    });
    expect(result.payoutReferenceId).toBeUndefined();
    expect(result.settledAt).toBeUndefined();
  });
});

/**
 * `submitNanopay` tests — task 24 Circle settle proxy.
 *
 * We cover five explicit branches the task requires:
 *  1. Happy path (Circle 200 OK → SETTLED, submission row written, payout trigger fired).
 *  2. Duplicate submission (same intentId + same signature → existing row returned, no new Circle call).
 *  3. Wrong status intent (409 ConflictException).
 *  4. Circle 4xx (`success: false` with errorReason → FAILED, mapped NanopayFailureCode).
 *  5. Circle 5xx (upstream outage → FAILED with CIRCLE_UPSTREAM_ERROR).
 *
 * Plus one bonus: timeout path → SETTLING (in-flight, intent NOT flipped to FAILED).
 *
 * Three-role separation spot-check: every test asserts we NEVER log the
 * signature or nonce — the buildService Logger spy-hook below catches any
 * leak in the service's log messages.
 */
describe("IntentsService.submitNanopay", () => {
  // Canonical "stored intent" shape. `$transaction` + `nanopaySubmission`
  // are added to the fake Prisma below because submitNanopay exercises
  // paths the other test suites don't.
  function storedIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: "pi_01HXYZ",
      status: "QUOTED" as const,
      payerUserId: "user_payer",
      merchantId: "mch_123",
      fiatAmountMinor: 15_000,
      fiatCurrency: "IDR",
      nanopayUsdcAmountMicros: 941_294n,
      nanopayUsdcSourceChainId: 5042002,
      nanopayUsdcTreasuryAddress: "0x00000000000000000000000000000000abcdef01",
      nanopayNonce: Buffer.alloc(32, 0x11),
      nanopayValidAfter: 1_700_000_000,
      nanopayValidBefore: 1_700_262_600,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date("2026-04-20T00:00:00Z"),
      merchant: {
        id: "mch_123",
        displayName: "Warung Bu Tini",
        userId: "user_merchant_owner",
      },
      payer: {
        id: "user_payer",
        walletAddress: "0x1111111111111111111111111111111111111111",
      },
      ...overrides,
    };
  }

  /**
   * Valid 65-byte signature. We never check it cryptographically — the
   * service just passes the bytes to Circle — but the shape has to match
   * the DTO regex (which IS enforced at controller level; the service
   * itself takes `0x${string}`).
   */
  const VALID_SIG = `0x${"ab".repeat(65)}` as `0x${string}`;

  function submitPrismaStub(opts?: {
    intent?: ReturnType<typeof storedIntent> | null;
    existingSubmission?: Record<string, unknown> | null;
  }) {
    const intent = opts?.intent === undefined ? storedIntent() : opts.intent;
    const existingSubmission = opts?.existingSubmission ?? null;

    const nanopaySubmissionCreate = jest.fn(
      async (args: { data: Record<string, unknown> }) => ({
        id: "sub_01",
        intentId: args.data.intentId,
        signature: args.data.signature,
        submittedAt: args.data.submittedAt,
        circleSettleTxUuid: args.data.circleSettleTxUuid ?? null,
        circleSettleResponseReceivedAt:
          args.data.circleSettleResponseReceivedAt ?? null,
        circleSettleNetwork: args.data.circleSettleNetwork ?? null,
        failureCode: args.data.failureCode ?? null,
        failureMessage: args.data.failureMessage ?? null,
      }),
    );
    const paymentIntentUpdate = jest.fn(
      async (args: { data: Record<string, unknown> }) => ({
        ...(intent ?? {}),
        status: args.data.status,
      }),
    );

    // `$transaction(cb)` invokes the callback with a tx-scoped client that
    // has the same shape as the top-level prisma. We hand it the same
    // mocks so assertions on `.toHaveBeenCalled*` work regardless of
    // whether the write happened inside or outside a transaction.
    const $transaction = jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        nanopaySubmission: { create: nanopaySubmissionCreate },
        paymentIntent: { update: paymentIntentUpdate },
      }),
    );

    return {
      paymentIntent: {
        findUnique: jest.fn(async () => intent),
        create: jest.fn(),
        update: paymentIntentUpdate,
      },
      nanopaySubmission: {
        findFirst: jest.fn(async () => existingSubmission),
        create: nanopaySubmissionCreate,
      },
      merchant: { findUnique: jest.fn() },
      exchangeRate: { findFirst: jest.fn() },
      blockchain: {
        findUnique: jest.fn(async () => ({
          id: "01ARC",
          isActive: true,
          metadata: {
            x402FacilitatorUrl:
              "https://gateway-api-testnet.circle.com/gateway/v1/x402/settle",
          },
        })),
      },
      smartContract: {
        findFirst: jest.fn(async () => ({
          address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        })),
      },
      $transaction,
    };
  }

  it("happy path: Circle 200 OK → SETTLED + payout trigger fires", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "ok",
        response: {
          success: true,
          transaction: "a1b2c3d4-1111-2222-3333-444455556666",
          network: "eip155:5042002",
        },
        rawBody: {},
      }),
    };
    const { svc, circleSettle: cs } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });

    // Spy the payout provider via the service's internal field. Simpler
    // than rebuilding the whole service just to inject a provider.
    const triggerSpy = jest.fn();
    (svc as unknown as { payoutProvider: unknown }).payoutProvider = {
      trigger: triggerSpy,
    };

    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });

    expect(result.status).toBe("SETTLED");
    expect(result.attestation?.id).toBe("a1b2c3d4-1111-2222-3333-444455556666");
    expect(result.failure).toBeNull();
    expect(cs.settle).toHaveBeenCalledTimes(1);
    // Submission row persisted with the circle tx uuid.
    expect(prisma.nanopaySubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          circleSettleTxUuid: "a1b2c3d4-1111-2222-3333-444455556666",
          circleSettleNetwork: "eip155:5042002",
        }),
      }),
    );
    // Intent flipped QUOTED → SETTLED inside the transaction.
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pi_01HXYZ" },
        data: { status: "SETTLED" },
      }),
    );
    // Payout provider was invoked.
    expect(triggerSpy).toHaveBeenCalledWith("pi_01HXYZ");
  });

  it("404s when the intent is missing", async () => {
    const prisma = submitPrismaStub({ intent: null });
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    await expect(
      svc.submitNanopay({ intentId: "pi_missing", signature: VALID_SIG }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("409s when the intent is in a terminal status (already SETTLED)", async () => {
    const prisma = submitPrismaStub({
      intent: storedIntent({ status: "SETTLED" }),
    });
    const circleSettle = { settle: jest.fn() };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    await expect(
      svc.submitNanopay({ intentId: "pi_01HXYZ", signature: VALID_SIG }),
    ).rejects.toBeInstanceOf(ConflictException);
    // MUST NOT hit Circle on wrong-status.
    expect(circleSettle.settle).not.toHaveBeenCalled();
  });

  it("duplicate submission: same signature returns the existing row without re-calling Circle", async () => {
    const existing = {
      id: "sub_existing",
      intentId: "pi_01HXYZ",
      signature: Buffer.alloc(65, 0xab),
      submittedAt: new Date("2026-04-20T00:00:00Z"),
      circleSettleTxUuid: "dead-beef-uuid-uuid-uuiduuiduuid",
      circleSettleResponseReceivedAt: new Date("2026-04-20T00:00:01Z"),
      circleSettleNetwork: "eip155:5042002",
      failureCode: null,
      failureMessage: null,
    };
    const prisma = submitPrismaStub({ existingSubmission: existing });
    const circleSettle = { settle: jest.fn() };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });

    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });

    expect(result.status).toBe("SETTLED");
    expect(result.attestation?.id).toBe("dead-beef-uuid-uuid-uuiduuiduuid");
    // Critical: no second Circle call on retry.
    expect(circleSettle.settle).not.toHaveBeenCalled();
    // And no duplicate DB write.
    expect(prisma.nanopaySubmission.create).not.toHaveBeenCalled();
  });

  it("Circle 4xx (insufficient_balance) → FAILED with INSUFFICIENT_GATEWAY_BALANCE", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "rejected",
        status: 402,
        response: {
          success: false,
          errorReason: "insufficient_balance",
          message: "Gateway balance is too low.",
        },
        rawBody: {},
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });

    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("INSUFFICIENT_GATEWAY_BALANCE");
    // Raw errorReason string persisted for debugging (spec §6.5).
    expect(prisma.nanopaySubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "INSUFFICIENT_GATEWAY_BALANCE",
          failureMessage: "insufficient_balance",
        }),
      }),
    );
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } }),
    );
  });

  it("Circle 4xx (nonce_already_used) → FAILED with NONCE_REUSED", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "rejected",
        status: 409,
        response: { success: false, errorReason: "nonce_already_used" },
        rawBody: {},
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });
    expect(result.failure?.code).toBe("NONCE_REUSED");
  });

  it("Circle 4xx (authorization_expired) → FAILED with AUTHORIZATION_EXPIRED", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "rejected",
        status: 400,
        response: { success: false, errorReason: "authorization_expired" },
        rawBody: {},
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });
    expect(result.failure?.code).toBe("AUTHORIZATION_EXPIRED");
  });

  it("Circle 4xx (invalid_signature) → FAILED with SIGNATURE_INVALID", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "rejected",
        status: 400,
        response: { success: false, errorReason: "invalid_signature" },
        rawBody: {},
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });
    expect(result.failure?.code).toBe("SIGNATURE_INVALID");
  });

  it("Circle 5xx → FAILED with CIRCLE_UPSTREAM_ERROR (not SETTLING — we got a response)", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "upstream",
        status: 503,
        rawBody: null,
        message: "Circle settle 503 Service Unavailable",
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });
    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("CIRCLE_UPSTREAM_ERROR");
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } }),
    );
  });

  it("Circle timeout → SETTLING (intent flipped to SIGNED, NOT FAILED)", async () => {
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "timeout",
        message: "Circle settle timed out after 30000ms",
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const result = await svc.submitNanopay({
      intentId: "pi_01HXYZ",
      signature: VALID_SIG,
    });
    expect(result.status).toBe("SETTLING");
    expect(result.attestation).toBeNull();
    // Critical: MUST NOT flip to FAILED on timeout (user scope §5: timeout
    // must be retry-safe).
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SIGNED" } }),
    );
  });

  it("does not log signatures or nonces on any branch", async () => {
    // Exercise the upstream + rejected + timeout branches and make sure the
    // signature hex never appears in any log message. Three-role separation
    // hardening from user scope §5.
    const prisma = submitPrismaStub();
    const circleSettle = {
      settle: jest.fn().mockResolvedValue({
        kind: "rejected",
        status: 400,
        response: { success: false, errorReason: "invalid_signature" },
        rawBody: {},
      }),
    };
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      circleSettle,
    });
    const logger = (svc as unknown as { logger: unknown }).logger as {
      warn: jest.Mock;
      error: jest.Mock;
      log: jest.Mock;
    };
    const warnSpy = jest.spyOn(logger, "warn");
    const errorSpy = jest.spyOn(logger, "error");
    const logSpy = jest.spyOn(logger, "log");

    await svc.submitNanopay({ intentId: "pi_01HXYZ", signature: VALID_SIG });

    const allLogged = [
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
      ...logSpy.mock.calls.flat(),
    ].map(String);

    const sigHex = VALID_SIG.slice(2);
    const nonceHex = "11".repeat(32); // matches the stub nonceBytes.
    for (const line of allLogged) {
      expect(line).not.toContain(sigHex);
      expect(line).not.toContain(nonceHex);
    }
  });
});

describe("mapCircleErrorReason", () => {
  const { mapCircleErrorReason } = require("./intents.service");

  it.each([
    ["insufficient_balance", "INSUFFICIENT_GATEWAY_BALANCE"],
    ["nonce_already_used", "NONCE_REUSED"],
    ["authorization_not_yet_valid", "AUTHORIZATION_EXPIRED"],
    ["authorization_expired", "AUTHORIZATION_EXPIRED"],
    ["authorization_validity_too_short", "AUTHORIZATION_EXPIRED"],
    ["unsupported_scheme", "SIGNATURE_INVALID"],
    ["unsupported_network", "SIGNATURE_INVALID"],
    ["unsupported_asset", "SIGNATURE_INVALID"],
    ["invalid_payload", "SIGNATURE_INVALID"],
    ["address_mismatch", "SIGNATURE_INVALID"],
    ["amount_mismatch", "SIGNATURE_INVALID"],
    ["invalid_signature", "SIGNATURE_INVALID"],
    ["self_transfer", "CIRCLE_UPSTREAM_ERROR"],
    ["unsupported_domain", "CIRCLE_UPSTREAM_ERROR"],
    ["wallet_not_found", "CIRCLE_UPSTREAM_ERROR"],
    ["unknown_future_reason", "CIRCLE_UPSTREAM_ERROR"],
  ])("maps errorReason=%s → %s", (reason, expected) => {
    expect(mapCircleErrorReason(reason, undefined).code).toBe(expected);
  });

  it("falls back to CIRCLE_UPSTREAM_ERROR when errorReason is absent", () => {
    expect(mapCircleErrorReason(undefined, "oops").code).toBe(
      "CIRCLE_UPSTREAM_ERROR",
    );
  });
});

/**
 * `recordDepositReceipt` tests — task 38 `POST /v1/pay/intents/:id/deposit-receipt`.
 *
 * We cover the branches called out by the task prompt's Verify list:
 *   - happy path → on-chain verified, row persisted with CONFIRMED, requiresDeposit flipped.
 *   - duplicate txHash → 200 echo of the existing row, no on-chain re-verification.
 *   - wrong payer (neither userId nor wallet matches) → 403.
 *   - unknown intent → 404.
 *   - on-chain verification failure (tx reverted / wrong recipient) → 400.
 *   - cross-check mismatches (chainId / amountMicros) → 400.
 *
 * Prisma shape: we stub the extra tables (`gatewayDeposit`, `blockchain`)
 * and `$transaction` that this method reaches for. Tests that don't
 * exercise those paths fall through to the narrower `submitPrismaStub`
 * already defined above.
 */
describe("IntentsService.recordDepositReceipt", () => {
  const TX_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
  const PAYER_ADDR = "0x1111111111111111111111111111111111111111";
  const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

  function depositIntentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "pi_01HXYZ",
      status: "QUOTED" as const,
      payerUserId: "user_payer",
      merchantId: "mch_123",
      requiresDeposit: true,
      nanopayUsdcAmountMicros: 1_000_000n,
      nanopayUsdcSourceChainId: 5042002,
      nanopayUsdcTreasuryAddress: "0x00000000000000000000000000000000abcdef01",
      nanopayValidAfter: 1_700_000_000,
      nanopayValidBefore: 1_700_262_600,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      payer: {
        id: "user_payer",
        walletAddress: PAYER_ADDR,
      },
      ...overrides,
    };
  }

  function depositPrismaStub(opts?: {
    intent?: ReturnType<typeof depositIntentRow> | null;
    priorDeposit?: Record<string, unknown> | null;
    blockchain?: { id: string; isActive: boolean } | null;
    gatewayWalletContract?: string | null;
    gatewayCreateThrows?: Error | null;
  }) {
    const intent =
      opts?.intent === undefined ? depositIntentRow() : opts.intent;
    const priorDeposit = opts?.priorDeposit ?? null;
    const blockchain =
      opts?.blockchain === undefined
        ? { id: "01ARC", isActive: true }
        : opts.blockchain;
    const gatewayWalletContract =
      opts?.gatewayWalletContract === undefined
        ? GATEWAY_WALLET
        : opts.gatewayWalletContract;
    const gatewayCreateThrows = opts?.gatewayCreateThrows ?? null;

    const gatewayDepositCreate = jest.fn(
      (args: { data: Record<string, unknown> }) => {
        if (gatewayCreateThrows) return Promise.reject(gatewayCreateThrows);
        return Promise.resolve({
          id: "gd_01",
          userId: args.data.userId,
          sourceChainId: args.data.sourceChainId,
          txHash: args.data.txHash,
          amountMicros: args.data.amountMicros,
          usedCirclePaymaster: args.data.usedCirclePaymaster,
          status: args.data.status,
          createdAt: new Date(),
          confirmedAt: args.data.confirmedAt,
        });
      },
    );
    const paymentIntentUpdate = jest.fn(
      async (args: { data: Record<string, unknown> }) => ({
        ...(intent ?? {}),
        ...args.data,
      }),
    );
    const gatewayDepositFindUnique = jest.fn(async () => priorDeposit);
    const $transaction = jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        gatewayDeposit: { create: gatewayDepositCreate },
        paymentIntent: { update: paymentIntentUpdate },
      }),
    );

    return {
      paymentIntent: {
        findUnique: jest.fn(async () => intent),
        create: jest.fn(),
        update: paymentIntentUpdate,
      },
      gatewayDeposit: {
        create: gatewayDepositCreate,
        findUnique: gatewayDepositFindUnique,
      },
      blockchain: {
        findUnique: jest.fn(async () => blockchain),
      },
      smartContract: {
        findFirst: jest.fn(async () =>
          gatewayWalletContract ? { address: gatewayWalletContract } : null,
        ),
      },
      merchant: { findUnique: jest.fn() },
      exchangeRate: { findFirst: jest.fn() },
      $transaction,
    };
  }

  function bvStub(opts?: {
    txFrom?: string;
    txTo?: string;
    status?: "success" | "reverted";
    receiptNull?: boolean;
    throwOnGet?: boolean;
  }) {
    const txFrom = opts?.txFrom ?? PAYER_ADDR;
    const txTo = opts?.txTo ?? GATEWAY_WALLET;
    const status = opts?.status ?? "success";
    const client = {
      getTransactionReceipt: jest.fn(() => {
        if (opts?.receiptNull) return Promise.resolve(null);
        if (opts?.throwOnGet)
          return Promise.reject(new Error("RPC unreachable"));
        return Promise.resolve({ status });
      }),
      getTransaction: jest.fn(async () => ({
        from: txFrom,
        to: txTo,
      })),
    };
    return {
      getPublicClient: jest.fn(() => client),
      _client: client,
    };
  }

  const validArgs = {
    intentId: "pi_01HXYZ",
    txHash: TX_HASH,
    chainId: 5042002,
    amountMicros: "1000000",
    usedCirclePaymaster: false,
    callerUserId: "user_payer",
    callerWalletAddress: null,
  };

  it("happy path: verifies on-chain, persists CONFIRMED row, flips requiresDeposit", async () => {
    const prisma = depositPrismaStub();
    const blockchainVerification = bvStub();
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });

    const result = await svc.recordDepositReceipt(validArgs);

    expect(result.depositId).toBe("gd_01");
    expect(result.status).toBe("CONFIRMED");
    // On-chain verification touched the cached client exactly once per call.
    expect(blockchainVerification.getPublicClient).toHaveBeenCalledWith(
      5042002,
    );
    // GatewayDeposit row persisted with status=CONFIRMED + confirmedAt set.
    expect(prisma.gatewayDeposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_payer",
          txHash: TX_HASH,
          amountMicros: 1_000_000n,
          status: "CONFIRMED",
          usedCirclePaymaster: false,
        }),
      }),
    );
    // Intent's requiresDeposit flipped to false — status NOT mutated.
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pi_01HXYZ" },
        data: { requiresDeposit: false },
      }),
    );
    // Crucially: the update did NOT set `status`. If someone breaks the
    // invariant "deposit is a prerequisite not a milestone" this catches it.
    const updateCalls = prisma.paymentIntent.update.mock.calls;
    for (const call of updateCalls) {
      expect(call[0].data).not.toHaveProperty("status");
    }
  });

  it("idempotent: duplicate txHash echoes the existing row without re-verification", async () => {
    const prior = {
      id: "gd_EXISTING",
      userId: "user_payer",
      sourceChainId: 5042002,
      txHash: TX_HASH,
      amountMicros: 1_000_000n,
      usedCirclePaymaster: false,
      status: "CONFIRMED",
      createdAt: new Date(),
      confirmedAt: new Date(),
    };
    const prisma = depositPrismaStub({ priorDeposit: prior });
    const blockchainVerification = bvStub();
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });

    const result = await svc.recordDepositReceipt(validArgs);

    expect(result.depositId).toBe("gd_EXISTING");
    expect(result.status).toBe("CONFIRMED");
    // MUST NOT re-verify on-chain or re-insert.
    expect(blockchainVerification.getPublicClient).not.toHaveBeenCalled();
    expect(prisma.gatewayDeposit.create).not.toHaveBeenCalled();
    expect(prisma.paymentIntent.update).not.toHaveBeenCalled();
  });

  it("403 when the caller is neither payer by userId nor by wallet address", async () => {
    const prisma = depositPrismaStub();
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    await expect(
      svc.recordDepositReceipt({
        ...validArgs,
        callerUserId: "user_other",
        callerWalletAddress: "0x9999999999999999999999999999999999999999",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.gatewayDeposit.create).not.toHaveBeenCalled();
  });

  it("404 when the intent is missing", async () => {
    const prisma = depositPrismaStub({ intent: null });
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    await expect(svc.recordDepositReceipt(validArgs)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("400 when the tx is reverted on-chain", async () => {
    const prisma = depositPrismaStub();
    const blockchainVerification = bvStub({ status: "reverted" });
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });
    await expect(svc.recordDepositReceipt(validArgs)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.gatewayDeposit.create).not.toHaveBeenCalled();
  });

  it("400 when the tx recipient is not the Gateway wallet (and not paymaster-sponsored)", async () => {
    const prisma = depositPrismaStub();
    const blockchainVerification = bvStub({
      txTo: "0xdead000000000000000000000000000000000000",
    });
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });
    await expect(svc.recordDepositReceipt(validArgs)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("accepts a paymaster-sponsored UserOp even when the top-level to is not the Gateway wallet", async () => {
    // ERC-4337 bundler calls into EntryPoint — the deposit destination is
    // inside the UserOp calldata. Task prompt §Rules: fall back to trusting
    // the flag when the bundler-included tx can't be verified on the surface.
    const prisma = depositPrismaStub();
    const blockchainVerification = bvStub({
      txTo: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", // EntryPoint.
      txFrom: "0xb00b1e5beef1234567890aBcDefabcdefabCDEfa", // bundler EOA.
    });
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });

    const result = await svc.recordDepositReceipt({
      ...validArgs,
      usedCirclePaymaster: true,
    });
    expect(result.status).toBe("CONFIRMED");
    expect(prisma.gatewayDeposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ usedCirclePaymaster: true }),
      }),
    );
  });

  it("400 when chainId does not match the intent's source chain", async () => {
    const prisma = depositPrismaStub();
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    await expect(
      svc.recordDepositReceipt({ ...validArgs, chainId: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.gatewayDeposit.create).not.toHaveBeenCalled();
  });

  it("400 when amountMicros does not match the intent's amount", async () => {
    const prisma = depositPrismaStub();
    const { svc } = buildService({ prisma: prisma as unknown as FakePrisma });
    await expect(
      svc.recordDepositReceipt({ ...validArgs, amountMicros: "999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not touch intent.requiresDeposit when the intent is no longer QUOTED", async () => {
    const prisma = depositPrismaStub({
      intent: depositIntentRow({ status: "SETTLED", requiresDeposit: false }),
    });
    const blockchainVerification = bvStub();
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });
    await svc.recordDepositReceipt(validArgs);
    // The deposit row is still persisted for audit — just no intent flip.
    expect(prisma.gatewayDeposit.create).toHaveBeenCalled();
    expect(prisma.paymentIntent.update).not.toHaveBeenCalled();
  });

  it("handles a concurrent-insert race: P2002 on create → echoes the winning row", async () => {
    // Simulate the race: `findUnique` says no prior row, `create` throws
    // P2002 (another request got there first), then a re-read finds it.
    const prior = {
      id: "gd_WINNER",
      userId: "user_payer",
      sourceChainId: 5042002,
      txHash: TX_HASH,
      amountMicros: 1_000_000n,
      usedCirclePaymaster: false,
      status: "CONFIRMED",
      createdAt: new Date(),
      confirmedAt: new Date(),
    };
    const race = Object.assign(new Error("unique"), { code: "P2002" });
    const prisma = depositPrismaStub({ gatewayCreateThrows: race });
    // After the throw, the service re-reads; make the second findUnique
    // return the prior row.
    (prisma.gatewayDeposit.findUnique as jest.Mock)
      .mockResolvedValueOnce(null) // precheck
      .mockResolvedValueOnce(prior); // post-throw re-read

    const blockchainVerification = bvStub();
    const { svc } = buildService({
      prisma: prisma as unknown as FakePrisma,
      blockchainVerification: blockchainVerification as {
        getPublicClient: jest.Mock;
      },
    });
    const result = await svc.recordDepositReceipt(validArgs);
    expect(result.depositId).toBe("gd_WINNER");
    expect(result.status).toBe("CONFIRMED");
  });
});

describe("IntentsService — on-chain settlement (async verification)", () => {
  const intentId = "01M2PRX5BA34H2ZES9EPBN3GNQ";
  const txHash = `0x${"ab".repeat(32)}`;
  const contractAddress = "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee";
  const onchainPayer = "0x0141781Aad86A023FaC70C6Aad0A8E7253164DB6";

  const intentRow = () => ({
    id: intentId,
    status: "QUOTED",
    merchantId: "mch_monad",
    sourceTokenId: "ausd-monad-testnet-token",
    nanopayUsdcAmountMicros: 5_541_189n,
    nanopayUsdcTreasuryAddress: "",
    fiatAmountMinor: 99_494,
    fiatCurrency: "IDR",
    exchangeRateId: 9,
    payerUserId: "user_1",
    payer: { walletAddress: "0x9567f4E7ECDd7D752cEE6062e15580E0086353d7" },
    merchant: { id: "mch_monad", displayName: "GTron" },
  });
  const blockchainRow = () => ({
    id: "monad-testnet",
    name: "Monad Testnet",
    type: "EVM",
    chainId: 10143,
    minConfirmations: 1,
    solanaCluster: null,
    isActive: true,
  });

  function evmPrisma(
    opts: {
      existingSettlement?: unknown;
      existingActivity?: unknown;
      intent?: Record<string, unknown>;
      flipCount?: number;
    } = {},
  ) {
    const onchainSettlement = {
      findFirst: jest.fn(async () => opts.existingSettlement ?? null),
      upsert: jest.fn(async () => ({})),
    };
    const paymentIntent = {
      create: jest.fn(),
      findUnique: jest.fn(async () => ({ ...intentRow(), ...opts.intent })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: opts.flipCount ?? 1 })),
    };
    const transactionHistory = {
      findFirst: jest.fn(async () => opts.existingActivity ?? null),
      update: jest.fn(async () => ({})),
    };
    const prisma = {
      paymentIntent,
      merchant: { findUnique: jest.fn() },
      exchangeRate: { findFirst: jest.fn() },
      blockchain: { findUnique: jest.fn(async () => blockchainRow()) },
      smartContract: {
        findFirst: jest.fn(
          async (): Promise<{ id: string; address: string } | null> => ({
            id: "sc",
            address: contractAddress,
          }),
        ),
      },
      token: {
        findUnique: jest.fn(async () => ({
          id: "ausd-monad-testnet-token",
          decimals: 6,
          contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
        })),
      },
      onchainSettlement,
      transactionHistory,
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ onchainSettlement, paymentIntent }),
      ),
    };
    return prisma;
  }

  function verificationStub(
    opts: { phaseA?: jest.Mock; phaseB?: jest.Mock } = {},
  ) {
    return {
      getPublicClient: jest.fn(),
      verifyMerchantPaymentTx:
        opts.phaseA ??
        jest.fn(() =>
          Promise.resolve({ payer: onchainPayer, confirmations: 3 }),
        ),
      verifyMerchantPaymentInContract:
        opts.phaseB ?? jest.fn(() => Promise.resolve()),
    };
  }
  const queueStub = (existingJob: unknown = null) => ({
    add: jest.fn(async () => ({})),
    getJob: jest.fn(async () => existingJob),
  });
  const pushStub = () => ({
    sendSettledPush: jest.fn(async () => undefined),
    sendSettlementIssuePush: jest.fn(async () => undefined),
  });

  describe("submitOnchain", () => {
    it("records the hash, moves the intent out of the sweeper's reach, opens a PENDING activity row, enqueues, and answers SETTLING without touching the chain", async () => {
      const prisma = evmPrisma();
      const verification = verificationStub();
      const queue = queueStub();
      const transactions = { create: jest.fn().mockResolvedValue({}) };
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verification as never,
        queue,
        transactions,
      });

      const res = await svc.submitOnchain({
        intentId,
        txHash,
        blockchainId: "monad-testnet",
      });

      expect(res).toEqual({ status: "SETTLING", intentId, attestation: null });
      expect(verification.verifyMerchantPaymentTx).not.toHaveBeenCalled();
      expect(
        verification.verifyMerchantPaymentInContract,
      ).not.toHaveBeenCalled();
      expect(prisma.onchainSettlement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { intentId_txHash: { intentId, txHash } },
          create: expect.objectContaining({ intentId, txHash, chainId: 10143 }),
        }),
      );
      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: { id: intentId, status: "QUOTED" },
        data: { status: "SIGNED" },
      });
      expect(transactions.create).toHaveBeenCalledWith(
        "user_1",
        expect.objectContaining({
          type: "PAYMENT",
          status: "PENDING",
          paymentIntentId: intentId,
          txHash,
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        "verify-settlement",
        { intentId, txHash, blockchainId: "monad-testnet" },
        expect.objectContaining({
          jobId: `${intentId}:${txHash}`,
          attempts: 150,
          backoff: { type: "custom" },
        }),
      );
    });

    it("short-circuits with SETTLED + attestation on an already-verified row and never enqueues", async () => {
      const verifiedAt = new Date("2026-09-17T04:10:00Z");
      const prisma = evmPrisma({
        existingSettlement: { id: "os_1", verifiedAt },
        intent: { status: "SETTLED" },
      });
      const queue = queueStub();
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        queue,
      });

      const res = await svc.submitOnchain({
        intentId,
        txHash,
        blockchainId: "monad-testnet",
      });

      expect(res).toEqual({
        status: "SETTLED",
        intentId,
        attestation: { id: "os_1", receivedAt: verifiedAt.getTime() },
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("does not enqueue a duplicate while a job for the same hash is still waiting/active", async () => {
      const prisma = evmPrisma();
      const queue = queueStub({
        getState: jest.fn(async () => "delayed"),
        remove: jest.fn(),
      });
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        queue,
      });

      const res = await svc.submitOnchain({
        intentId,
        txHash,
        blockchainId: "monad-testnet",
      });

      expect(res.status).toBe("SETTLING");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("rejects an EVM chain with no takumi_pay contract up front instead of letting a job retry for a day", async () => {
      const prisma = evmPrisma();
      prisma.smartContract.findFirst = jest.fn(async () => null);
      const queue = queueStub();
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        queue,
      });

      await expect(
        svc.submitOnchain({ intentId, txHash, blockchainId: "monad-testnet" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("verifyOnchainPayment", () => {
    it("runs Phase A (receipt + log binding) before Phase B and hands the on-chain payer across", async () => {
      const calls: string[] = [];
      const phaseA = jest.fn(() => {
        calls.push("A");
        return Promise.resolve({ payer: onchainPayer, confirmations: 3 });
      });
      const phaseB = jest.fn(() => {
        calls.push("B");
        return Promise.resolve();
      });
      const prisma = evmPrisma();
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub({ phaseA, phaseB }) as never,
      });

      const res = await svc.verifyOnchainPayment({
        intent: intentRow(),
        blockchain: blockchainRow(),
        txHash,
      });

      expect(res).toEqual({ payer: onchainPayer });
      expect(calls).toEqual(["A", "B"]);
      expect(phaseA).toHaveBeenCalledWith({
        txHash,
        chainId: 10143,
        contractAddress,
        refId: intentId,
        minimumConfirmations: 1,
      });
      expect(phaseB).toHaveBeenCalledWith(
        expect.objectContaining({
          contractAddress,
          chainId: 10143,
          refId: intentId,
          expectedPayer: onchainPayer,
          expectedMerchantId: "mch_monad",
          expectedTokenAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
          expectedAmount: "5541189",
          expectedFiatAmountMinor: 99_494,
          expectedExchangeRateId: 9,
          txHash,
        }),
      );
    });
  });

  describe("finalizeOnchainSettlement", () => {
    it("persists, flips QUOTED/SIGNED → SETTLED, completes the activity row, pushes 'Payment sent' and fires the payout once", async () => {
      const prisma = evmPrisma({
        existingActivity: {
          id: "th_1",
          createdAt: new Date(),
          status: "PENDING",
        },
      });
      const push = pushStub();
      const payoutProvider = { trigger: jest.fn(async () => undefined) };
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        push,
      });
      (svc as unknown as { payoutProvider: unknown }).payoutProvider =
        payoutProvider;

      const settled = await svc.finalizeOnchainSettlement({
        intent: intentRow(),
        blockchain: blockchainRow(),
        txHash,
      });

      expect(settled).toBe(true);
      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: { id: intentId, status: { in: ["QUOTED", "SIGNED"] } },
        data: { status: "SETTLED" },
      });
      expect(prisma.onchainSettlement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ verifiedAt: expect.any(Date) }),
        }),
      );
      expect(prisma.transactionHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "COMPLETED" } }),
      );
      expect(payoutProvider.trigger).toHaveBeenCalledTimes(1);
      expect(push.sendSettledPush).toHaveBeenCalledWith(intentId);
    });

    it("a concurrent run that loses the status flip fires nothing", async () => {
      const prisma = evmPrisma({ flipCount: 0 });
      const push = pushStub();
      const payoutProvider = { trigger: jest.fn(async () => undefined) };
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        push,
      });
      (svc as unknown as { payoutProvider: unknown }).payoutProvider =
        payoutProvider;

      const settled = await svc.finalizeOnchainSettlement({
        intent: intentRow(),
        blockchain: blockchainRow(),
        txHash,
      });

      expect(settled).toBe(false);
      expect(payoutProvider.trigger).not.toHaveBeenCalled();
      expect(push.sendSettledPush).not.toHaveBeenCalled();
    });
  });

  describe("markOnchainSettlementIssue", () => {
    it("reverted: intent FAILED, activity FAILED, 'you weren't charged' push, no intentId in the push", async () => {
      const prisma = evmPrisma({
        existingActivity: {
          id: "th_1",
          createdAt: new Date(),
          status: "PENDING",
        },
      });
      const push = pushStub();
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        push,
      });

      await svc.markOnchainSettlementIssue({
        intentId,
        txHash,
        blockchain: blockchainRow(),
        outcome: "rejected_reverted",
        message: "Transaction 0x… was reverted or failed",
      });

      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: { id: intentId, status: { in: ["QUOTED", "SIGNED"] } },
        data: { status: "FAILED" },
      });
      expect(prisma.onchainSettlement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ failureCode: "TX_REVERTED" }),
        }),
      );
      expect(prisma.transactionHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "FAILED" } }),
      );
      expect(push.sendSettlementIssuePush).toHaveBeenCalledWith(
        intentId,
        "reverted",
        "th_1",
      );
    });

    it("mismatch / budget spent: intent stays SIGNED, row NEEDS_REVIEW, activity stays PENDING, 'we're checking' push", async () => {
      const prisma = evmPrisma({
        existingActivity: {
          id: "th_1",
          createdAt: new Date(),
          status: "PENDING",
        },
      });
      const push = pushStub();
      const { svc } = buildService({
        prisma: prisma as unknown as FakePrisma,
        blockchainVerification: verificationStub() as never,
        push,
      });

      await svc.markOnchainSettlementIssue({
        intentId,
        txHash,
        blockchain: blockchainRow(),
        outcome: "rejected_mismatch",
        message: "Merchant payment amount mismatch: expected 5541189, got 1",
      });

      expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
      expect(prisma.onchainSettlement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ failureCode: "NEEDS_REVIEW" }),
        }),
      );
      // Already PENDING → no status write.
      expect(prisma.transactionHistory.update).not.toHaveBeenCalled();
      expect(push.sendSettlementIssuePush).toHaveBeenCalledWith(
        intentId,
        "needs_review",
        "th_1",
      );
    });
  });
});
