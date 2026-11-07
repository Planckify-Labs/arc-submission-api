import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { BookingService } from "./booking.service";
import { BookingStatus } from "./enums/booking-status.enum";
import type { BlockchainsService } from "../blockchains/blockchains.service";
import type { ProductInputValidatorService } from "../products/services/product-input-validator.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { BookingCacheService } from "../valkey/services/booking-cache.service";
import type { ExchangeRateService } from "../exchange-rate/exchange-rate.service";
import type { PointsHoldService } from "../points-hold/points-hold.service";

/**
 * BookingService unit tests.
 *
 * The service does heavy work inside `prisma.$transaction` so the harness
 * provides a tx-aware Prisma stub that lets us assert the exact ordering of
 * blockchain → token → variant → exchange-rate → bookingOrder lookups along
 * with the rejection paths each step has to enforce.
 */

const ACTIVE_BLOCKCHAIN = {
  id: "bc_polygon",
  chainId: 137,
  name: "Polygon",
  isActive: true,
};

const INACTIVE_BLOCKCHAIN = {
  id: "bc_inactive",
  chainId: 56,
  name: "Inactive",
  isActive: false,
};

const ACTIVE_TOKEN = {
  id: "tk_usdc_polygon",
  symbol: "USDC",
  decimals: 6,
  isActive: true,
  blockchainId: "bc_polygon",
  contractAddress: "0xUSDC",
};

const PRODUCT_VARIANT = {
  id: "pv_001",
  name: "86 Diamonds",
  variantCode: "ML-86D",
  product: { id: "prod_001", name: "Mobile Legends" },
  ProductPrice: [
    {
      id: "pp_001",
      sellPrice: "100000",
      currency: "IDR",
      isActive: true,
    },
  ],
};

const ACTIVE_EXCHANGE_RATE = {
  id: 42,
  rate: 15700,
  fromCurrency: "USDC",
  toCurrency: "IDR",
  isActive: true,
};

interface PrismaStubOpts {
  blockchain?: typeof ACTIVE_BLOCKCHAIN | typeof INACTIVE_BLOCKCHAIN | null;
  token?: typeof ACTIVE_TOKEN | (typeof ACTIVE_TOKEN & { isActive: boolean }) | null;
  productVariant?: typeof PRODUCT_VARIANT | null;
  exchangeRate?: typeof ACTIVE_EXCHANGE_RATE | null;
  bookingFindUnique?: Record<string, unknown> | null;
  bookingFindFirst?: Record<string, unknown> | null;
  bookings?: Record<string, unknown>[];
  customerInfoValid?: boolean;
  /** Buyer's points balance. */
  balance?: bigint;
  /** Make the guarded decrement lose a race. */
  holdConflict?: boolean;
}

function buildHarness(opts: PrismaStubOpts = {}) {
  const blockchain = opts.blockchain === undefined ? ACTIVE_BLOCKCHAIN : opts.blockchain;
  const token = opts.token === undefined ? ACTIVE_TOKEN : opts.token;
  const productVariant =
    opts.productVariant === undefined ? PRODUCT_VARIANT : opts.productVariant;
  const exchangeRate =
    opts.exchangeRate === undefined ? ACTIVE_EXCHANGE_RATE : opts.exchangeRate;

  const txCalls = {
    tokenFindUnique: jest.fn(async () => token),
    productVariantFindUnique: jest.fn(async () => productVariant),
    bookingOrderCreate: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "booking_001",
      walletAddress: data.walletAddress,
      productVariantId: data.productVariantId,
      productPriceId: data.productPriceId,
      payment: data.payment,
      pointsApplied: data.pointsApplied,
      pointsHoldStatus: data.pointsHoldStatus,
      exchangeRate: data.exchangeRate,
      customerInfo: data.customerInfo,
      status: data.status,
      expiresAt: data.expiresAt,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      productVariant,
      productPrice: productVariant?.ProductPrice?.[0],
    })),
  };

  const tx: Record<string, unknown> = {
    token: { findUnique: txCalls.tokenFindUnique },
    productVariant: { findUnique: txCalls.productVariantFindUnique },
    bookingOrder: { create: txCalls.bookingOrderCreate },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    bookingOrder: {
      findMany: jest.fn(async () => opts.bookings ?? []),
      findUnique: jest.fn(async () => opts.bookingFindUnique ?? null),
      findFirst: jest.fn(async () => opts.bookingFindFirst ?? null),
      count: jest.fn(async () => opts.bookings?.length ?? 0),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "booking_001",
        ...data,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    token: {
      findUnique: jest.fn(async () => token),
    },
  } as unknown as PrismaService;

  const blockchainsService = {
    findOne: jest.fn(async () => blockchain),
  } as unknown as BlockchainsService;

  const productInputValidator = {
    validateCustomerInfo: jest.fn(async (_pid: string, info: unknown) => {
      await Promise.resolve();
      if (opts.customerInfoValid === false) {
        throw new BadRequestException("invalid customer info");
      }
      return info ?? {};
    }),
  } as unknown as ProductInputValidatorService;

  const bookingCache = {
    invalidateUserBookings: jest.fn(async () => undefined),
    invalidateBooking: jest.fn(async () => undefined),
    getLatestBooking: jest.fn(async (_addr: string, fallback: () => unknown) =>
      fallback(),
    ),
  } as unknown as BookingCacheService;

  const config = {
    get: jest.fn((_key: string, defaultValue: number) => defaultValue),
  } as unknown as ConfigService;

  const exchangeRateService = {
    findLatest: jest.fn(async () => exchangeRate),
  } as unknown as ExchangeRateService;

  const holds = {
    balanceOf: jest.fn(async () => opts.balance ?? 0n),
    holdInTx: jest.fn(async () => {
      if (opts.holdConflict) {
        throw new ConflictException("Your points balance changed");
      }
    }),
    invalidate: jest.fn(async () => undefined),
    release: jest.fn(async () => true),
  } as unknown as jest.Mocked<PointsHoldService>;

  const svc = new BookingService(
    prisma,
    config,
    blockchainsService,
    productInputValidator,
    bookingCache,
    exchangeRateService,
    holds,
  );

  return {
    svc,
    prisma,
    blockchainsService,
    bookingCache,
    productInputValidator,
    exchangeRateService,
    holds,
    txCalls,
  };
}

const validDto = () => ({
  walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
  productVariantId: "pv_001",
  productPriceId: "pp_001",
  payment: {
    tokenAddress: "0xUSDC",
    blockchainId: "bc_polygon",
    exchangeRateId: 42,
  },
  customerInfo: { phoneNumber: "6281234567890" },
});

describe("BookingService.createBooking", () => {
  it("creates a booking and locks the exchange rate", async () => {
    const { svc, blockchainsService, bookingCache, txCalls } = buildHarness();
    const result = await svc.createBooking(validDto());

    expect(blockchainsService.findOne).toHaveBeenCalledWith("bc_polygon");
    expect(txCalls.bookingOrderCreate).toHaveBeenCalledTimes(1);
    expect(bookingCache.invalidateUserBookings).toHaveBeenCalledWith(
      validDto().walletAddress,
    );
    expect(result.id).toBe("booking_001");
    expect(result.payment.exchangeRate.rate).toBe(15700);
    expect(result.status).toBe("PENDING");
    expect(typeof result.payment.token.amount).toBe("string");
    // 100000 IDR / 15700 IDR-per-USDC ≈ 6.369 USDC, scaled by 10^6.
    expect(BigInt(result.payment.token.amount)).toBeGreaterThan(6_000_000n);
    expect(BigInt(result.payment.token.amount)).toBeLessThan(7_000_000n);
  });

  it("throws NotFound when the blockchain doesn't exist", async () => {
    const { svc } = buildHarness({ blockchain: null });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects an inactive blockchain with 400", async () => {
    const { svc } = buildHarness({ blockchain: INACTIVE_BLOCKCHAIN });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when token isn't registered on the chain (400)", async () => {
    const { svc } = buildHarness({ token: null });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects an inactive token (400)", async () => {
    const { svc } = buildHarness({
      token: { ...ACTIVE_TOKEN, isActive: false },
    });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("404s when the product variant is gone", async () => {
    const { svc } = buildHarness({ productVariant: null });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects a variant with no active price (400)", async () => {
    const { svc } = buildHarness({
      productVariant: { ...PRODUCT_VARIANT, ProductPrice: [] },
    });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when exchange rate is missing", async () => {
    const { svc } = buildHarness({ exchangeRate: null });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects when the latest exchange rate is no longer active", async () => {
    const { svc, txCalls } = buildHarness({
      exchangeRate: { ...ACTIVE_EXCHANGE_RATE, isActive: false },
    });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(txCalls.bookingOrderCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-positive rate instead of dividing by it", async () => {
    const { svc, txCalls } = buildHarness({
      exchangeRate: { ...ACTIVE_EXCHANGE_RATE, rate: 0 },
    });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(txCalls.bookingOrderCreate).not.toHaveBeenCalled();
  });

  it("rejects a productPriceId that is not the active price", async () => {
    const { svc, txCalls } = buildHarness();
    await expect(
      svc.createBooking({ ...validDto(), productPriceId: "pp_pricier" }),
    ).rejects.toThrow(/not the active price/);
    expect(txCalls.bookingOrderCreate).not.toHaveBeenCalled();
  });

  it("stores the active price id it validated", async () => {
    const { svc, txCalls } = buildHarness();
    await svc.createBooking(validDto());
    expect(txCalls.bookingOrderCreate.mock.calls[0][0].data.productPriceId).toBe(
      "pp_001",
    );
  });

  it("chooses the rate server-side and ignores the client's exchangeRateId", async () => {
    const { svc, exchangeRateService, txCalls } = buildHarness();
    const dto = validDto();
    dto.payment.exchangeRateId = 999;
    const result = await svc.createBooking(dto);

    expect(exchangeRateService.findLatest).toHaveBeenCalledWith({
      fromCurrency: "USDC",
      toCurrency: "IDR",
    });
    const stored = txCalls.bookingOrderCreate.mock.calls[0][0].data;
    expect((stored.exchangeRate as { id: number }).id).toBe(42);
    expect(result.payment.exchangeRate.id).toBe(42);
  });

  it("accepts a booking without exchangeRateId (field is optional)", async () => {
    const { svc } = buildHarness();
    const dto = validDto();
    delete (dto.payment as { exchangeRateId?: number }).exchangeRateId;
    await expect(svc.createBooking(dto)).resolves.toBeDefined();
  });

  it("rounds the token amount UP to the smallest unit", async () => {
    const { svc } = buildHarness();
    const result = await svc.createBooking(validDto());
    // 100000 / 15700 * 10^6 = 6369426.7515...; floor would charge 6369426.
    expect(result.payment.token.amount).toBe("6369427");
  });

  it("does not add a unit to an exact amount", async () => {
    const { svc } = buildHarness({
      exchangeRate: { ...ACTIVE_EXCHANGE_RATE, rate: 16000 },
      productVariant: {
        ...PRODUCT_VARIANT,
        ProductPrice: [{ ...PRODUCT_VARIANT.ProductPrice[0], sellPrice: "50000" }],
      },
    });
    const result = await svc.createBooking(validDto());
    expect(result.payment.token.amount).toBe("3125000");
  });

  it("keeps every digit on an 18-decimal token", async () => {
    const { svc } = buildHarness({ token: { ...ACTIVE_TOKEN, decimals: 18 } });
    const result = await svc.createBooking(validDto());
    // 100000 / 15700 = 6.369426751592356687898089..., rounded up in wei.
    // The old parseFloat * 10 ** decimals path could not represent this.
    expect(result.payment.token.amount).toBe("6369426751592356688");
  });

  it("propagates customer-info validation errors", async () => {
    const { svc } = buildHarness({ customerInfoValid: false });
    await expect(svc.createBooking(validDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("BookingService.createBooking with points", () => {
  const withPoints = () => ({ ...validDto(), usePoints: true });
  // 100000 IDR at 15700 IDR/USDC: minRemainder = ceil(0.3 x 15700) = 4710.

  it("applies a partial balance and charges tokens for the rest", async () => {
    const { svc, holds, txCalls } = buildHarness({ balance: 30000n });
    const result = await svc.createBooking(withPoints(), "user_1");

    expect(result.payment.pointsApplied).toBe("30000");
    // ceil(70000 x 1e6 / 15700) = 4458599
    expect(result.payment.token.amount).toBe("4458599");
    expect(result.product.price.amount).toBe(100000);
    expect(txCalls.bookingOrderCreate.mock.calls[0][0].data).toMatchObject({
      pointsApplied: 30000n,
      pointsHoldStatus: "HELD",
    });
    expect(holds.holdInTx).toHaveBeenCalledWith(expect.anything(), {
      userId: "user_1",
      bookingId: "booking_001",
      points: 30000n,
    });
    expect(holds.invalidate).toHaveBeenCalledWith("user_1");
  });

  it("a balance covering the whole price still leaves the minimum in tokens", async () => {
    const { svc } = buildHarness({ balance: 1_000_000n });
    const result = await svc.createBooking(withPoints(), "user_1");
    expect(result.payment.pointsApplied).toBe((100000 - 4710).toString());
    // The remainder is 4710 IDR -> ceil(4710 x 1e6 / 15700) = 300000 = 0.30 USDC.
    expect(result.payment.token.amount).toBe("300000");
  });

  it("a tiny price where nothing applies is a normal booking, not an error", async () => {
    const { svc, holds, txCalls } = buildHarness({
      balance: 50000n,
      productVariant: {
        ...PRODUCT_VARIANT,
        ProductPrice: [{ ...PRODUCT_VARIANT.ProductPrice[0], sellPrice: "4000" }],
      },
    });
    const result = await svc.createBooking(withPoints(), "user_1");
    expect(result.payment.pointsApplied).toBe("0");
    expect(txCalls.bookingOrderCreate.mock.calls[0][0].data).toMatchObject({
      pointsApplied: 0n,
      pointsHoldStatus: "NONE",
    });
    expect(holds.holdInTx).not.toHaveBeenCalled();
    // 4000 / 15700 USDC, rounded up
    expect(result.payment.token.amount).toBe("254778");
  });

  it("keeps full precision on an 18-decimal token", async () => {
    const { svc } = buildHarness({
      token: { ...ACTIVE_TOKEN, decimals: 18 },
      balance: 30000n,
    });
    const result = await svc.createBooking(withPoints(), "user_1");
    // 70000e18 / 15700 = 4458598726114649681.528... -> 4458598726114649682
    expect(result.payment.token.amount).toBe("4458598726114649682");
  });

  it("zero balance, or usePoints off, behaves exactly as before", async () => {
    const off = buildHarness({ balance: 99999n });
    const a = await off.svc.createBooking(validDto(), "user_1");
    expect(a.payment.pointsApplied).toBe("0");
    expect(a.payment.token.amount).toBe("6369427");
    expect(off.holds.balanceOf).not.toHaveBeenCalled();
    expect(off.holds.holdInTx).not.toHaveBeenCalled();

    const empty = buildHarness({ balance: 0n });
    const b = await empty.svc.createBooking(withPoints(), "user_1");
    expect(b.payment.token.amount).toBe("6369427");
  });

  it("a guard that loses a balance race fails the booking with a conflict", async () => {
    const { svc } = buildHarness({ balance: 30000n, holdConflict: true });
    await expect(
      svc.createBooking(withPoints(), "user_1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("BookingService.expireBookings", () => {
  it("invalidates the booking cache only when at least one row was expired", async () => {
    const { svc, prisma, bookingCache } = buildHarness();
    (prisma.bookingOrder.updateMany as jest.Mock).mockResolvedValueOnce({
      count: 0,
    });
    await svc.expireBookings();
    expect(bookingCache.invalidateBooking).not.toHaveBeenCalled();

    (prisma.bookingOrder.updateMany as jest.Mock).mockResolvedValueOnce({
      count: 4,
    });
    await svc.expireBookings();
    expect(bookingCache.invalidateBooking).toHaveBeenCalledTimes(1);
  });

  it("never expires a booking that already has a purchase (paid, awaiting confirmations)", async () => {
    const { svc, prisma } = buildHarness();
    await svc.expireBookings();
    const where = (prisma.bookingOrder.updateMany as jest.Mock).mock.calls[0][0]
      .where;
    expect(where.status).toBe(BookingStatus.PENDING);
    expect(where.purchase).toBeNull();
  });
});

describe("BookingService.markBookingExecuted", () => {
  const owner = {
    id: "user_1",
    walletAddress: "0xUSER",
    role: "USER",
  };

  it("404s on missing booking", async () => {
    const { svc } = buildHarness({ bookingFindUnique: null });
    await expect(svc.markBookingExecuted("missing", owner)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("forbids non-owner non-admin", async () => {
    const { svc } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: "0xOTHER",
        status: BookingStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(svc.markBookingExecuted("b1", owner)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows admin to execute a booking they don't own", async () => {
    const { svc, bookingCache } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: "0xOTHER",
        status: BookingStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const out = await svc.markBookingExecuted("b1", { ...owner, role: "ADMIN" });
    expect(out).toBeDefined();
    expect(bookingCache.invalidateBooking).toHaveBeenCalled();
  });

  it("rejects non-PENDING bookings (400)", async () => {
    const { svc } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: owner.walletAddress,
        status: BookingStatus.EXECUTED,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(svc.markBookingExecuted("b1", owner)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects expired bookings (400)", async () => {
    const { svc } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: owner.walletAddress,
        status: BookingStatus.PENDING,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await expect(svc.markBookingExecuted("b1", owner)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("transitions PENDING → EXECUTED for the owner", async () => {
    const { svc, prisma, bookingCache } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: owner.walletAddress,
        status: BookingStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await svc.markBookingExecuted("b1", owner);
    expect(prisma.bookingOrder.update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { status: "EXECUTED" },
    });
    expect(bookingCache.invalidateBooking).toHaveBeenCalledWith(
      "b1",
      owner.walletAddress,
    );
  });
});

describe("BookingService.cancelBooking", () => {
  const owner = { id: "u", walletAddress: "0xUSER", role: "USER" };

  it("404s on missing", async () => {
    const { svc } = buildHarness({ bookingFindUnique: null });
    await expect(svc.cancelBooking("x", owner)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("forbids non-owner non-admin", async () => {
    const { svc } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: "0xOTHER",
        status: BookingStatus.PENDING,
      },
    });
    await expect(svc.cancelBooking("b1", owner)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("rejects non-pending bookings", async () => {
    const { svc } = buildHarness({
      bookingFindUnique: {
        id: "b1",
        walletAddress: owner.walletAddress,
        status: BookingStatus.EXECUTED,
      },
    });
    await expect(svc.cancelBooking("b1", owner)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  const pendingBooking = {
    id: "b1",
    walletAddress: owner.walletAddress,
    status: BookingStatus.PENDING,
    purchase: null,
  };

  it("cancels, releases any held points and invalidates cache", async () => {
    const { svc, prisma, bookingCache, holds } = buildHarness({
      bookingFindUnique: pendingBooking,
    });
    await svc.cancelBooking("b1", owner);
    expect(prisma.bookingOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: BookingStatus.PENDING, purchase: null },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(holds.release).toHaveBeenCalledWith("b1", "booking cancelled");
    expect(bookingCache.invalidateBooking).toHaveBeenCalled();
  });

  it("refuses a booking that already has a purchase, and releases nothing", async () => {
    const { svc, prisma, holds } = buildHarness({
      bookingFindUnique: { ...pendingBooking, purchase: { id: "pur_1" } },
    });
    // The guarded update matches no row because a purchase exists.
    (prisma.bookingOrder.updateMany as jest.Mock).mockResolvedValueOnce({
      count: 0,
    });
    await expect(svc.cancelBooking("b1", owner)).rejects.toThrow(
      /payment in progress/,
    );
    expect(holds.release).not.toHaveBeenCalled();
  });
});

describe("BookingService.getBookings filter assembly", () => {
  it("layers status, productId, createdFrom and createdTo into the where clause", async () => {
    const { svc, prisma } = buildHarness();
    await svc.getBookings("0xWALL", {
      status: BookingStatus.EXECUTED,
      productId: "pv_001",
      createdFrom: new Date("2026-01-01T00:00:00Z"),
      createdTo: new Date("2026-02-01T00:00:00Z"),
    } as never);

    const findMany = (prisma.bookingOrder.findMany as jest.Mock).mock.calls[0][0];
    expect(findMany.where).toMatchObject({
      walletAddress: "0xWALL",
      status: BookingStatus.EXECUTED,
      productVariantId: "pv_001",
    });
    expect(findMany.where.createdAt.gte).toBeInstanceOf(Date);
    expect(findMany.where.createdAt.lte).toBeInstanceOf(Date);
  });

  it("omits status/productId/date filters when query is empty", async () => {
    const { svc, prisma } = buildHarness();
    await svc.getBookings("0xWALL", {} as never);
    const findMany = (prisma.bookingOrder.findMany as jest.Mock).mock.calls[0][0];
    expect(findMany.where).toEqual({ walletAddress: "0xWALL" });
  });
});

describe("BookingService.getBookingStats", () => {
  it("computes conversion + expiration rates and avg execution time", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.bookingOrder.count as jest.Mock)
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(2) // pending
      .mockResolvedValueOnce(5) // executed
      .mockResolvedValueOnce(2) // expired
      .mockResolvedValueOnce(1); // cancelled
    (prisma.bookingOrder.findMany as jest.Mock).mockResolvedValueOnce([
      {
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
        updatedAt: new Date(Date.now()),
      },
      {
        createdAt: new Date(Date.now() - 15 * 60 * 1000),
        updatedAt: new Date(Date.now()),
      },
    ]);

    const stats = await svc.getBookingStats("0xWALL");
    expect(stats.total).toBe(10);
    expect(stats.executed).toBe(5);
    expect(stats.conversionRate).toBeCloseTo(0.5, 5);
    expect(stats.expirationRate).toBeCloseTo(0.2, 5);
    expect(stats.avgTimeToExecution).toBeGreaterThan(0);
  });

  it("returns avgTimeToExecution undefined when no executed bookings", async () => {
    const { svc, prisma } = buildHarness();
    (prisma.bookingOrder.count as jest.Mock)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    (prisma.bookingOrder.findMany as jest.Mock).mockResolvedValueOnce([]);
    const stats = await svc.getBookingStats("0xWALL");
    expect(stats.conversionRate).toBe(0);
    expect(stats.avgTimeToExecution).toBeUndefined();
  });
});

describe("BookingService.getLatestBooking", () => {
  it("returns null when no pending booking exists", async () => {
    const { svc } = buildHarness({ bookingFindFirst: null });
    const out = await svc.getLatestBooking("0xWALL");
    expect(out).toBeNull();
  });

  it("formats the booking when one exists", async () => {
    const { svc } = buildHarness({
      bookingFindFirst: {
        id: "b_latest",
        walletAddress: "0xWALL",
        status: BookingStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        productVariant: PRODUCT_VARIANT,
        productPrice: PRODUCT_VARIANT.ProductPrice[0],
        payment: {
          tokenAddress: "0xUSDC",
          blockchainNetworkId: "bc_polygon",
          amount: "6369426",
        },
        exchangeRate: {
          id: 42,
          rate: 15700,
          fromCurrency: "USDC",
          toCurrency: "IDR",
          lockedAt: new Date().toISOString(),
        },
      },
    });
    const out = await svc.getLatestBooking("0xWALL");
    expect(out).toBeDefined();
    expect(out?.id).toBe("b_latest");
  });
});
