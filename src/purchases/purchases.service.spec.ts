import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { ReferenceIdService } from "../reference-id/reference-id.service";
import type { QueueService } from "../queue/queue.service";
import type { BlockchainCacheService } from "../valkey/services/blockchain-cache.service";
import type { SmartContractCacheService } from "../valkey/services/smart-contract-cache.service";
import type { TokenCacheService } from "../valkey/services/token-cache.service";
// PushService (reached via FulfilmentService) pulls in the ESM expo SDK.
jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { PurchasesService } from "./purchases.service";
import type { FulfilmentService } from "../fulfilment/fulfilment.service";

/**
 * PurchasesService unit tests.
 *
 * The create() flow is the gnarliest in the system: cache → blockchain → SC →
 * user upsert → token → placeholder TX → purchase row → queue dispatch, with
 * idempotency on `refId`. Tests pin each branch.
 */

type Defaults = {
  refIdStatus?: { status: string; metadata?: Record<string, unknown> } | null;
  booking?: Record<string, unknown> | null;
  blockchain?: { id: string; name: string; isActive: boolean } | null;
  smartContract?: { id: string; name: string; isActive: boolean } | null;
  token?: { id: string } | null;
  user?: { id: string } | null;
  queueThrows?: boolean;
  vendorStatusOk?: boolean;
};

function buildHarness(d: Defaults = {}) {
  const refIdStatus = d.refIdStatus === undefined ? null : d.refIdStatus;
  const booking =
    d.booking === undefined
      ? {
          id: "book_1",
          walletAddress: "0xUSER",
          productVariantId: "pv_1",
          productPrice: { sellPrice: "100000", currency: "IDR" },
          payment: {
            tokenAddress: "0xUSDC",
            blockchainNetworkId: "bc_polygon",
            amount: "6000000",
          },
          exchangeRate: {
            rate: 15700,
            fromCurrency: "USDC",
            toCurrency: "IDR",
          },
        }
      : d.booking;
  const blockchain =
    d.blockchain === undefined
      ? { id: "bc_polygon", name: "Polygon", isActive: true }
      : d.blockchain;
  const smartContract =
    d.smartContract === undefined
      ? { id: "sc_1", name: "TakumiPayContract", isActive: true }
      : d.smartContract;
  const token = d.token === undefined ? { id: "tk_usdc" } : d.token;
  const user = d.user === undefined ? null : d.user;

  const prisma = {
    bookingOrder: { findUnique: jest.fn(async () => booking) },
    blockchain: { findUnique: jest.fn(async () => blockchain) },
    smartContract: { findFirst: jest.fn(async () => smartContract) },
    user: {
      findUnique: jest.fn(async () => user),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "user_new",
        ...data,
      })),
    },
    token: { findUnique: jest.fn(async () => token) },
    transactionHistory: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "tx_placeholder",
        createdAt: new Date(),
        ...data,
      })),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    purchase: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pur_001",
        createdAt: new Date(),
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pur_001",
        ...data,
      })),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
  } as unknown as PrismaService;

  const referenceIdService = {
    getReferenceIdStatus: jest.fn(async () => refIdStatus),
    markAsProcessing: jest.fn(async () => undefined),
    markAsFailed: jest.fn(async () => undefined),
  } as unknown as ReferenceIdService;

  const queueService = {
    addPurchaseJob: jest.fn(async () => {
      await Promise.resolve();
      if (d.queueThrows) throw new Error("queue down");
      return "job_001";
    }),
  } as unknown as QueueService;

  const passThroughCache = {
    getById: jest.fn(async (_id: string, fallback: () => unknown) =>
      fallback(),
    ),
    getByBlockchainAndAddress: jest.fn(
      async (_a: string, _b: string, fallback: () => unknown) => fallback(),
    ),
  };
  const blockchainCache = passThroughCache as unknown as BlockchainCacheService;
  const contractCache =
    passThroughCache as unknown as SmartContractCacheService;
  const tokenCache = passThroughCache as unknown as TokenCacheService;

  const fulfilment = {
    check: jest.fn(async () => "DELIVERED"),
  } as unknown as FulfilmentService;

  const svc = new PurchasesService(
    prisma,
    referenceIdService,
    queueService,
    blockchainCache,
    contractCache,
    tokenCache,
    fulfilment,
  );

  return {
    svc,
    prisma,
    referenceIdService,
    queueService,
    fulfilment,
  };
}

const validDto = () => ({
  refId: "ref_001",
  bookingId: "book_1",
  walletAddress: "0xUSER",
  networkId: "bc_polygon",
  contractAddress: "0xCONTRACT",
  transactionHash: "0xtxhash",
});

describe("PurchasesService.create — happy path", () => {
  it("creates user, placeholder tx, purchase row, marks ref-id PROCESSING and enqueues", async () => {
    const { svc, prisma, referenceIdService, queueService } = buildHarness();
    const out = await svc.create(validDto());
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.transactionHistory.create).toHaveBeenCalled();
    expect(prisma.purchase.create).toHaveBeenCalled();
    expect(referenceIdService.markAsProcessing).toHaveBeenCalled();
    expect(queueService.addPurchaseJob).toHaveBeenCalledWith(
      expect.objectContaining({
        refId: "ref_001",
        bookingId: "book_1",
        purchaseId: "pur_001",
      }),
    );
    expect(out).toMatchObject({
      id: "pur_001",
      refId: "ref_001",
      jobId: "job_001",
      status: "PROCESSING",
    });
  });

  it("records only the token part as amountInFiat when points paid for the rest", async () => {
    const { svc, prisma } = buildHarness({
      booking: {
        id: "book_1",
        walletAddress: "0xUSER",
        productVariantId: "pv_1",
        pointsApplied: 30000n,
        productPrice: { sellPrice: "100000", currency: "IDR" },
        payment: {
          tokenAddress: "0xUSDC",
          blockchainNetworkId: "bc_polygon",
          amount: "4458599",
        },
        exchangeRate: { rate: 15700, fromCurrency: "USDC", toCurrency: "IDR" },
      },
    });
    await svc.create(validDto());
    expect(
      (prisma.transactionHistory.create as jest.Mock).mock.calls[0][0].data
        .amountInFiat,
    ).toBe("70000");
  });

  it("a booking with no points keeps amountInFiat at sellPrice", async () => {
    const { svc, prisma } = buildHarness();
    await svc.create(validDto());
    expect(
      (prisma.transactionHistory.create as jest.Mock).mock.calls[0][0].data
        .amountInFiat,
    ).toBe("100000");
  });

  it("reuses an existing user when wallet already known (no user.create)", async () => {
    const { svc, prisma } = buildHarness({ user: { id: "user_existing" } });
    await svc.create(validDto());
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe("PurchasesService.create — idempotency on refId", () => {
  it("returns the existing purchase when refId is COMPLETED with metadata", async () => {
    const existingPurchase = {
      id: "pur_old",
      productVariant: { id: "pv_1", product: { id: "p1" } },
    };
    const { svc, prisma, queueService } = buildHarness({
      refIdStatus: {
        status: "COMPLETED",
        metadata: { purchaseId: "pur_old", bookingId: "book_old" },
      },
    });
    (prisma.purchase.findUnique as jest.Mock).mockResolvedValueOnce(
      existingPurchase,
    );

    const out = await svc.create(validDto());
    expect(out).toMatchObject({ id: "pur_old", bookingId: "book_old" });
    expect(queueService.addPurchaseJob).not.toHaveBeenCalled();
  });

  it("returns processing-marker when refId is already PROCESSING", async () => {
    const { svc, queueService } = buildHarness({
      refIdStatus: { status: "PROCESSING" },
    });
    const out = await svc.create(validDto());
    expect(out).toMatchObject({
      refId: "ref_001",
      status: "PENDING",
      processingStatus: "in_progress",
    });
    expect(queueService.addPurchaseJob).not.toHaveBeenCalled();
  });
});

describe("PurchasesService.create — input validation", () => {
  it("404s when booking does not exist", async () => {
    const { svc } = buildHarness({ booking: null });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects wallet address mismatch (400)", async () => {
    const { svc } = buildHarness({
      booking: {
        id: "book_1",
        walletAddress: "0xOTHER_ADDR",
        productVariantId: "pv",
        productPrice: { sellPrice: "1", currency: "IDR" },
        payment: {
          tokenAddress: "0xUSDC",
          blockchainNetworkId: "bc_polygon",
          amount: "1",
        },
        exchangeRate: { rate: 1, fromCurrency: "USDC", toCurrency: "IDR" },
      },
    });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when networkId on the body doesn't match the booking's network", async () => {
    const { svc } = buildHarness({
      booking: {
        id: "book_1",
        walletAddress: "0xUSER",
        productVariantId: "pv",
        productPrice: { sellPrice: "1", currency: "IDR" },
        payment: {
          tokenAddress: "0xUSDC",
          blockchainNetworkId: "bc_DIFFERENT",
          amount: "1",
        },
        exchangeRate: { rate: 1, fromCurrency: "USDC", toCurrency: "IDR" },
      },
    });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("404s when blockchain not found", async () => {
    const { svc } = buildHarness({ blockchain: null });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects inactive blockchain", async () => {
    const { svc } = buildHarness({
      blockchain: { id: "bc_polygon", name: "Polygon", isActive: false },
    });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when smart contract not found", async () => {
    const { svc } = buildHarness({ smartContract: null });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects inactive smart contract", async () => {
    const { svc } = buildHarness({
      smartContract: { id: "sc_1", name: "X", isActive: false },
    });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when token not found on the network", async () => {
    const { svc } = buildHarness({ token: null });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("PurchasesService.create — queue failure rollback", () => {
  it("marks the purchase FAILED and the refId failed when enqueue throws", async () => {
    const { svc, prisma, referenceIdService } = buildHarness({
      queueThrows: true,
    });
    await expect(svc.create(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.purchase.update).toHaveBeenCalledWith({
      where: { id: "pur_001" },
      data: { status: "FAILED" },
    });
    expect(referenceIdService.markAsFailed).toHaveBeenCalled();
  });
});

describe("PurchasesService.findOne", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "pur_x",
    transactionId: "tx_y",
    transactionCreatedAt: new Date(),
    productVariantId: "pv",
    refId: "ref",
    status: "COMPLETED",
    vendorStatusResponse: null,
    vendorRefId: "vendor_ref",
    fulfilmentStatus: "DELIVERED",
    fulfilmentError: null,
    delivery: {
      kind: "voucher",
      primary: { label: "Code", value: "ABC123", copyable: true },
      fields: [],
      raw: "ABC123",
      parse: "heuristic",
      parserId: "heuristic@1",
    },
    deliveryRaw: "ABC123",
    expectedBy: null,
    fulfilledAt: new Date("2026-09-19T00:00:00Z"),
    vendorLastCheckedAt: new Date(),
    refund: null,
    productVariant: { product: { deliveryType: null, isVoucher: true } },
    bookingOrder: {
      id: "b",
      createdAt: new Date(),
      customerInfo: [],
      walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it("404s on missing", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.purchase.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.findOne("missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns purchase + transaction joined manually for hypertable, with the fulfilment block", async () => {
    const { svc, prisma, fulfilment } = buildHarness();
    (prisma.purchase.findUnique as jest.Mock).mockResolvedValueOnce(row());
    (prisma.transactionHistory.findFirst as jest.Mock).mockResolvedValueOnce({
      id: "tx_y",
      token: { blockchain: {} },
    });

    const out = (await svc.findOne("pur_x")) as Record<string, unknown>;
    expect(out.id).toBe("pur_x");
    // Legacy field for app versions that predate `delivery`.
    expect(out.voucherCode).toBe("ABC123");
    const f = out.fulfilment as Record<string, unknown>;
    expect(f.status).toBe("DELIVERED");
    expect(f.deliveryType).toBe("VOUCHER_CODE");
    expect((f.delivery as { primary: { value: string } }).primary.value).toBe(
      "ABC123",
    );
    // Delivered: nothing to ask the vendor.
    expect(fulfilment.check).not.toHaveBeenCalled();
  });

  it("asks the vendor through the state machine when the order is still open", async () => {
    const { svc, prisma, fulfilment } = buildHarness();
    (prisma.purchase.findUnique as jest.Mock)
      .mockResolvedValueOnce(
        row({
          fulfilmentStatus: "SUBMITTED",
          delivery: null,
          deliveryRaw: null,
          vendorLastCheckedAt: null,
        }),
      )
      .mockResolvedValueOnce(row());
    (prisma.transactionHistory.findFirst as jest.Mock).mockResolvedValueOnce(
      null,
    );

    const out = (await svc.findOne("pur_x", {
      vendorResponse: true,
    })) as Record<string, unknown>;
    expect(fulfilment.check).toHaveBeenCalledWith("purchase", "pur_x", {
      reschedule: false,
    });
    // The re-read after the check is what the caller sees.
    expect((out.fulfilment as { status: string }).status).toBe("DELIVERED");
  });

  it("a signed-in stranger gets a 404, the buyer and an admin get the row", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.purchase.findUnique as jest.Mock).mockResolvedValue(row());
    (prisma.transactionHistory.findFirst as jest.Mock).mockResolvedValue({
      id: "tx_y",
      userId: "buyer",
      token: { blockchain: {} },
    });

    await expect(
      svc.findOne("pur_x", {
        viewer: {
          id: "someone",
          walletAddress: "0x0000000000000000000000000000000000000001",
          role: "USER" as never,
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      svc.findOne("pur_x", {
        viewer: {
          id: "other",
          walletAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          role: "USER" as never,
        },
      }),
    ).resolves.toMatchObject({ id: "pur_x" });

    await expect(
      svc.findOne("pur_x", {
        viewer: { id: "buyer", walletAddress: null, role: "USER" as never },
      }),
    ).resolves.toMatchObject({ id: "pur_x" });

    await expect(
      svc.findOne("pur_x", {
        viewer: { id: "ops", walletAddress: null, role: "ADMIN" as never },
      }),
    ).resolves.toMatchObject({ id: "pur_x" });
  });
});

describe("PurchasesService.search", () => {
  it("returns empty when prefilter on user/token/blockchain finds zero txs", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.transactionHistory.findMany as jest.Mock).mockResolvedValueOnce([]);
    const out = await svc.search({ userId: "u" } as never, {});
    expect(out).toEqual({ items: [], total: 0 });
  });

  it("composes status, productId, vendorId filters when no tx prefilter is needed", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.purchase.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.purchase.count as jest.Mock).mockResolvedValueOnce(0);
    await svc.search(
      {
        status: "COMPLETED",
        productId: "p1",
        transactionId: "tx_x",
      } as never,
      {},
    );
    const findMany = (prisma.purchase.findMany as jest.Mock).mock.calls[0][0];
    expect(findMany.where.status).toBe("COMPLETED");
    expect(findMany.where.productVariant.product.id).toBe("p1");
    expect(findMany.where.transactionId).toBe("tx_x");
  });

  it("vendorId overrides productId on the productVariant key (last spread wins)", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.purchase.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.purchase.count as jest.Mock).mockResolvedValueOnce(0);
    await svc.search({ productId: "p1", vendorId: "v1" } as never, {});
    const findMany = (prisma.purchase.findMany as jest.Mock).mock.calls[0][0];
    // vendorId block is spread after productId, so the productVariant filter
    // becomes the ProductPrice/vendor variant.
    expect(findMany.where.productVariant.ProductPrice.some.vendor.id).toBe(
      "v1",
    );
  });
});

describe("PurchasesService.findByUser / findByToken / findByBlockchain", () => {
  it("findByUser 404s when user missing", async () => {
    const { svc } = buildHarness({ user: null });
    await expect(svc.findByUser("u", {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("findByToken 404s when token missing", async () => {
    const { svc } = buildHarness({ token: null });
    await expect(svc.findByToken("tk", {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("findByBlockchain 404s when blockchain missing", async () => {
    const { svc } = buildHarness({ blockchain: null });
    await expect(svc.findByBlockchain("bc", {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("findByUser returns empty when user has no transactions", async () => {
    const { svc, prisma } = buildHarness({ user: { id: "u" } });
    (prisma.transactionHistory.findMany as jest.Mock).mockResolvedValueOnce([]);
    const out = await svc.findByUser("u", {});
    expect(out).toEqual({ items: [], total: 0 });
  });
});

describe("PurchasesService.getReferenceIdWithPurchase", () => {
  it("returns null when no metadata", async () => {
    const { svc } = buildHarness({
      refIdStatus: { status: "COMPLETED", metadata: undefined },
    });
    const out = await svc.getReferenceIdWithPurchase("ref_x");
    expect(out).toBeNull();
  });

  it("returns null when purchaseId metadata is missing", async () => {
    const { svc } = buildHarness({
      refIdStatus: { status: "COMPLETED", metadata: { foo: "bar" } },
    });
    const out = await svc.getReferenceIdWithPurchase("ref_x");
    expect(out).toBeNull();
  });

  it("returns purchase + bookingId when complete metadata present", async () => {
    const { svc, prisma } = buildHarness({
      refIdStatus: {
        status: "COMPLETED",
        metadata: { purchaseId: "pur_z", bookingId: "book_z" },
      },
    });
    (prisma.purchase.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "pur_z",
      productVariant: {},
    });
    const out = await svc.getReferenceIdWithPurchase("ref_x");
    expect(out?.bookingId).toBe("book_z");
    expect(out?.purchase.id).toBe("pur_z");
  });
});
