jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { FulfilmentService } from "./fulfilment.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { VendorRegistry } from "../providers/vendor-api/vendor-registry.service";
import type { VendorOrderStatus } from "../providers/vendor-api/base/base-vendor.service";
import type { DeliveryParserService } from "../delivery/delivery-parser.service";
import type { PointsRefundService } from "../points/points-refund.service";
import type { PushService } from "../push/push.service";
import type { PointsHoldService } from "../points-hold/points-hold.service";
import type { Queue } from "bullmq";

type AnyFn = jest.Mock;
const HOUR = 60 * 60 * 1000;

function purchaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pur_1",
    fulfilmentStatus: "SUBMITTED",
    vendorRefId: "TRX1",
    createdAt: new Date(Date.now() - 60_000),
    expectedBy: new Date(Date.now() + 10 * 60_000),
    vendorCheckCount: 0,
    transactionId: "tx_1",
    transactionCreatedAt: new Date(),
    bookingOrder: {
      walletAddress: "0xabc",
      customerInfo: [{ key: "userId", value: "0812" }],
      productPrice: {
        sellPrice: "50000",
        currency: "IDR",
        vendor: { name: "acmePpob" },
      },
    },
    productVariant: {
      name: "86 Diamonds",
      slaSeconds: 1800,
      product: {
        code: "MLBB",
        name: "Mobile Legends",
        isVoucher: false,
        deliveryType: null,
        voucherTemplate: null,
      },
    },
    ...overrides,
  };
}

/** What any adapter hands back through the fulfilment port. */
function vendorStatus(
  outcome: VendorOrderStatus["outcome"],
  raw = "",
  extra: Partial<VendorOrderStatus> = {},
): VendorOrderStatus {
  return {
    outcome,
    raw: raw || null,
    response: { vendorBody: true, outcome },
    ...extra,
  };
}

function buildHarness(
  opts: {
    row?: Record<string, unknown>;
    vendor?: unknown;
    /** What the adapter reads from the order's cached vendor body. */
    cached?: unknown;
    flipCount?: number;
    /** The booking paid part of the price with held points. */
    held?: { points: bigint; consume: "CONSUMED" | "RELEASED" | "NONE" };
    /** What the transaction row recorded as the token part, in IDR. */
    tokenPartFiat?: string;
  } = {},
) {
  const base = purchaseRow(opts.row);
  const row = opts.held
    ? {
        ...base,
        bookingOrder: {
          ...base.bookingOrder,
          id: "book_1",
          pointsApplied: opts.held.points,
        },
      }
    : base;
  const prisma = {
    purchase: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: opts.flipCount ?? 1 })),
      update: jest.fn(async () => ({})),
    },
    pointRedemption: {
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: opts.flipCount ?? 1 })),
      update: jest.fn(async () => ({})),
    },
    transactionHistory: {
      findFirst: jest.fn(async () => ({
        amountInFiat: opts.tokenPartFiat ?? "50000",
        fiatCurrency: "IDR",
        userId: "u1",
      })),
    },
    adminAuditLog: { create: jest.fn(async () => ({})) },
  } as unknown as PrismaService;
  const queue = { add: jest.fn(async () => ({ id: "j" })) } as unknown as Queue;
  const adapter = {
    vendorName: "acmePpob",
    checkOrder: jest.fn(async () => opts.vendor ?? vendorStatus("pending")),
    readCachedStatus: jest.fn(() => opts.cached ?? null),
    classifyOrderFailure: jest.fn(
      (resp: { originalError?: { status?: number; message?: string } }) =>
        resp.originalError?.status === 422
          ? { cls: "definitive", reason: `422: ${resp.originalError.message}` }
          : { cls: "ambiguous", reason: "transport" },
    ),
  };
  const vendors = {
    get: jest.fn((name: string) => {
      if (name !== "acmePpob") throw new Error(`Unsupported vendor: ${name}`);
      return adapter;
    }),
    has: jest.fn((name: string) => name === "acmePpob"),
  } as unknown as VendorRegistry;
  const parser = {
    parseAndRecord: jest.fn(async (input: { raw: string | null }) => ({
      kind: "topup",
      fields: [],
      raw: input.raw,
      parse: input.raw ? "exact" : "none",
      parserId: null,
      target: "0812",
    })),
  } as unknown as DeliveryParserService;
  const refunds = {
    refund: jest.fn(async () => ({
      outcome: "credited",
      refundId: "ref_1",
      points: 50000n,
    })),
  } as unknown as PointsRefundService;
  const push = {
    sendFulfilmentPush: jest.fn(async () => undefined),
  } as unknown as PushService;
  const holds = {
    consume: jest.fn(async () => opts.held?.consume ?? "NONE"),
  } as unknown as jest.Mocked<PointsHoldService>;
  const svc = new FulfilmentService(
    prisma,
    queue,
    vendors,
    parser,
    refunds,
    push,
    holds,
  );
  return {
    svc,
    prisma,
    queue,
    vendors,
    adapter,
    parser,
    refunds,
    push,
    holds,
    row,
  };
}

const flushPush = () => new Promise((r) => setImmediate(r));

describe("FulfilmentService.onVendorAccepted", () => {
  it("QUEUED → SUBMITTED with an SLA-derived ETA, 'paid' push, first check in 15s", async () => {
    const { svc, prisma, queue, push } = buildHarness({
      row: { fulfilmentStatus: "QUEUED" },
    });
    await svc.onVendorAccepted("purchase", "pur_1");

    const flip = (prisma.purchase.updateMany as AnyFn).mock.calls[0][0];
    expect(flip.where).toEqual({
      id: "pur_1",
      fulfilmentStatus: { in: ["QUEUED"] },
    });
    expect(flip.data.fulfilmentStatus).toBe("SUBMITTED");
    const eta = (flip.data.expectedBy as Date).getTime() - Date.now();
    expect(eta).toBeGreaterThan(1700 * 1000);
    expect(eta).toBeLessThanOrEqual(1800 * 1000);

    await flushPush();
    expect(push.sendFulfilmentPush).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "paid",
        expectedMinutes: 30,
        walletAddress: "0xabc",
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "check",
      { kind: "purchase", id: "pur_1", attempt: 0 },
      expect.objectContaining({
        jobId: "fulfilment-purchase-pur_1-0",
        delay: 15_000,
      }),
    );
  });

  it("a worker retry after acceptance does not re-push, but still arms the poll", async () => {
    const { svc, queue, push } = buildHarness({ flipCount: 0 });
    await svc.onVendorAccepted("purchase", "pur_1");
    await flushPush();
    expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });
});

describe("FulfilmentService.check", () => {
  it("vendor status 2 → DELIVERED, delivery parsed and stored, money leg COMPLETED, 'ready' push", async () => {
    const { svc, prisma, parser, push, queue } = buildHarness({
      vendor: vendorStatus("delivered", "SERIAL-1"),
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 0,
      reschedule: true,
    });
    expect(out).toBe("DELIVERED");

    expect(parser.parseAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        productCode: "MLBB",
        deliveryType: "DIRECT_TOPUP",
        raw: "SERIAL-1",
      }),
    );
    const flips = (prisma.purchase.updateMany as AnyFn).mock.calls.map(
      (c) => c[0],
    );
    const delivered = flips.find(
      (f) => f.data.fulfilmentStatus === "DELIVERED",
    );
    expect(delivered.where.fulfilmentStatus.in).toEqual(
      expect.arrayContaining(["SUBMITTED", "DELAYED", "NEEDS_RECONCILE"]),
    );
    expect(delivered.data).toMatchObject({
      status: "COMPLETED",
      deliveryRaw: "SERIAL-1",
    });
    expect(delivered.data.delivery.kind).toBe("topup");

    await flushPush();
    expect(push.sendFulfilmentPush).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "delivered",
        deliveryKind: "topup",
        target: "0812",
      }),
    );
    // Terminal: no next check.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("vendor failure → FAILED, money leg FAILED, refund with the IDR amount from the locked tx", async () => {
    const { svc, prisma, refunds, queue } = buildHarness({
      vendor: vendorStatus("failed", "", { reason: "Gagal" }),
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 2,
      reschedule: true,
    });
    expect(out).toBe("FAILED");
    const flips = (prisma.purchase.updateMany as AnyFn).mock.calls.map(
      (c) => c[0],
    );
    expect(
      flips.find((f) => f.data.fulfilmentStatus === "FAILED").data.status,
    ).toBe("FAILED");
    expect(refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "purchase",
        id: "pur_1",
        userId: "u1",
        points: 50000n,
        currency: "IDR",
        source: "auto",
        productCode: "MLBB",
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("still pending inside the SLA → touch and schedule the next attempt with backoff", async () => {
    const { svc, prisma, queue, push } = buildHarness({
      vendor: vendorStatus("pending"),
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 3,
      reschedule: true,
    });
    expect(out).toBe("SUBMITTED");
    expect(prisma.purchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vendorCheckCount: { increment: 1 } }),
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "check",
      { kind: "purchase", id: "pur_1", attempt: 4 },
      expect.objectContaining({ delay: 300_000 }),
    );
    await flushPush();
    expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
  });

  it("pending past the SLA → DELAYED once, with a push", async () => {
    const { svc, prisma, push } = buildHarness({
      vendor: vendorStatus("pending"),
      row: { expectedBy: new Date(Date.now() - 1000) },
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 5,
      reschedule: true,
    });
    expect(out).toBe("DELAYED");
    expect(prisma.purchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pur_1", fulfilmentStatus: { in: ["SUBMITTED"] } },
        data: { fulfilmentStatus: "DELAYED" },
      }),
    );
    await flushPush();
    expect(push.sendFulfilmentPush).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "delayed" }),
    );
  });

  it("pending for more than 24h → NEEDS_RECONCILE, ops-facing, no refund", async () => {
    const { svc, prisma, refunds, push } = buildHarness({
      vendor: vendorStatus("pending"),
      row: {
        fulfilmentStatus: "DELAYED",
        createdAt: new Date(Date.now() - 25 * HOUR),
      },
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 9,
      reschedule: true,
    });
    expect(out).toBe("NEEDS_RECONCILE");
    expect(refunds.refund).not.toHaveBeenCalled();
    const flip = (prisma.purchase.updateMany as AnyFn).mock.calls.find(
      (c) => c[0].data.fulfilmentStatus === "NEEDS_RECONCILE",
    );
    expect(flip).toBeDefined();
    await flushPush();
    expect(push.sendFulfilmentPush).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "reconcile" }),
    );
  });

  it("a vendor transport failure is treated as pending, not as an outcome", async () => {
    const { svc, queue, refunds } = buildHarness({
      vendor: vendorStatus("pending", "", {
        unavailable: true,
        reason: "503: down",
      }),
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 0,
      reschedule: true,
    });
    expect(out).toBe("SUBMITTED");
    expect(refunds.refund).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it("delivered AFTER a refund keeps REFUNDED and flags the clawback", async () => {
    const { svc, prisma, refunds, push } = buildHarness({
      vendor: vendorStatus("delivered", "LATE-1"),
      row: { fulfilmentStatus: "REFUNDED" },
    });
    const out = await svc.check("purchase", "pur_1", {
      attempt: 3,
      reschedule: true,
    });
    expect(out).toBe("REFUNDED");
    const upd = (prisma.purchase.updateMany as AnyFn).mock.calls.find(
      (c) => c[0].data.deliveredAfterRefundAt,
    );
    expect(upd[0].where).toEqual({ id: "pur_1" });
    expect(upd[0].data.deliveryRaw).toBe("LATE-1");
    expect(refunds.refund).not.toHaveBeenCalled();
    await flushPush();
    expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
  });

  it("terminal rows and rows that never reached the vendor are not asked about", async () => {
    const delivered = buildHarness({ row: { fulfilmentStatus: "DELIVERED" } });
    expect(await delivered.svc.check("purchase", "pur_1")).toBe("DELIVERED");
    expect(delivered.adapter.checkOrder).not.toHaveBeenCalled();

    const queued = buildHarness({
      row: { fulfilmentStatus: "QUEUED", vendorRefId: null },
    });
    expect(await queued.svc.check("purchase", "pur_1")).toBe("QUEUED");
    expect(queued.adapter.checkOrder).not.toHaveBeenCalled();
  });
});

describe("FulfilmentService — order placement outcomes", () => {
  it("a definitive vendor rejection settles and refunds right away", async () => {
    const { svc, refunds } = buildHarness({
      row: { fulfilmentStatus: "QUEUED" },
    });
    const cls = await svc.onVendorRejected("purchase", "pur_1", {
      success: false,
      statusCode: 502,
      message: "Invalid vendor response",
      originalError: { status: 422, message: "invalid user id" },
    });
    expect(cls).toBe("definitive");
    expect(refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("invalid user id"),
      }),
    );
  });

  it("an ambiguous failure is left to the caller's retries", async () => {
    const { svc, refunds } = buildHarness({
      row: { fulfilmentStatus: "QUEUED" },
    });
    const cls = await svc.onVendorRejected("purchase", "pur_1", {
      success: false,
      statusCode: 503,
      message: "down",
      originalError: { status: 504, message: "timeout" },
    });
    expect(cls).toBe("ambiguous");
    expect(refunds.refund).not.toHaveBeenCalled();
  });

  it("retries exhausted before the vendor was reached → refund; after → reconcile", async () => {
    const never = buildHarness({ row: { fulfilmentStatus: "QUEUED" } });
    await never.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: false,
      error: "Customer info is required",
    });
    expect(never.refunds.refund).toHaveBeenCalled();

    const maybe = buildHarness({ row: { fulfilmentStatus: "QUEUED" } });
    await maybe.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: true,
      error: "timeout",
    });
    expect(maybe.refunds.refund).not.toHaveBeenCalled();
    const flip = (maybe.prisma.purchase.updateMany as AnyFn).mock.calls.find(
      (c) => c[0].data.fulfilmentStatus === "NEEDS_RECONCILE",
    );
    expect(flip).toBeDefined();
  });

  it("an unverified payment goes to ops, never to a points refund", async () => {
    const { svc, refunds, prisma } = buildHarness({
      row: { fulfilmentStatus: "QUEUED", vendorRefId: null },
    });
    await svc.onPaymentUnverified("purchase", "pur_1", "rpc down");
    expect(refunds.refund).not.toHaveBeenCalled();
    const flip = (prisma.purchase.updateMany as AnyFn).mock.calls.find(
      (c) => c[0].data.fulfilmentStatus === "NEEDS_RECONCILE",
    );
    expect(flip?.[0].data.fulfilmentError).toMatch(/payment not verified/);
  });
});

describe("FulfilmentService refunds with points held for the booking", () => {
  // 100,000 IDR product: 30,000 points + 70,000 IDR paid in tokens.
  const held = (consume: "CONSUMED" | "RELEASED" | "NONE") => ({
    held: { points: 30000n, consume },
    tokenPartFiat: "70000",
    row: { fulfilmentStatus: "QUEUED" },
  });

  it("a delivery failure after the hold was consumed refunds both parts, once", async () => {
    const h = buildHarness(held("CONSUMED"));
    await h.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: false,
      error: "x",
    });
    expect(h.holds.consume).toHaveBeenCalledWith("book_1");
    expect(h.refunds.refund).toHaveBeenCalledTimes(1);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ points: 100000n, fiatAmount: "100000" }),
    );
  });

  it("settling an order whose hold is still HELD takes it over (HELD -> CONSUMED) and refunds both parts", async () => {
    // The late-payment path: the worker never consumed the hold.
    const h = buildHarness(held("CONSUMED"));
    await h.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: false,
      error: "booking expired",
    });
    expect(h.holds.consume).toHaveBeenCalledTimes(1);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ points: 100000n }),
    );
  });

  it("a hold the sweep already released refunds only the token part", async () => {
    const h = buildHarness(held("RELEASED"));
    await h.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: false,
      error: "x",
    });
    expect(h.refunds.refund).toHaveBeenCalledTimes(1);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ points: 70000n, fiatAmount: "70000" }),
    );
  });

  it("an interrupted settle finished later computes the same full amount, without a second push or credit path", async () => {
    const h = buildHarness({
      ...held("CONSUMED"),
      row: { fulfilmentStatus: "FAILED" },
    });
    await h.svc.finishStrandedRefund("purchase", "pur_1");
    expect(h.refunds.refund).toHaveBeenCalledTimes(1);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ points: 100000n }),
    );
    // A second pass on an already-refunded order does nothing.
    const done = buildHarness({
      ...held("CONSUMED"),
      row: { fulfilmentStatus: "REFUNDED" },
    });
    await done.svc.finishStrandedRefund("purchase", "pur_1");
    expect(done.refunds.refund).not.toHaveBeenCalled();
    expect(done.holds.consume).not.toHaveBeenCalled();
  });

  it("a booking without points behaves exactly as before and never touches the hold", async () => {
    const h = buildHarness({ row: { fulfilmentStatus: "QUEUED" } });
    await h.svc.onOrderRetriesExhausted("purchase", "pur_1", {
      orderAttempted: false,
      error: "x",
    });
    expect(h.holds.consume).not.toHaveBeenCalled();
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ points: 50000n, fiatAmount: "50000" }),
    );
  });
});

describe("FulfilmentService.resolveManually", () => {
  it("ops 'failed' refunds as admin (bypassing cap/breaker) and audits", async () => {
    const { svc, refunds, prisma } = buildHarness({
      row: { fulfilmentStatus: "NEEDS_RECONCILE" },
    });
    await svc.resolveManually("purchase", "pur_1", {
      outcome: "failed",
      adminId: "ops",
      note: "vendor confirmed no order",
    });
    expect(refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ source: "admin", adminId: "ops" }),
    );
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "FULFILMENT_RESOLVE_FAILED",
          resourceId: "pur_1",
        }),
      }),
    );
  });

  it("ops 'delivered' with a pasted code stores the parsed delivery", async () => {
    const { svc, parser, prisma } = buildHarness({
      row: { fulfilmentStatus: "NEEDS_RECONCILE" },
    });
    const out = await svc.resolveManually("purchase", "pur_1", {
      outcome: "delivered",
      adminId: "ops",
      raw: "PASTED-1",
    });
    expect(out).toBe("DELIVERED");
    expect(parser.parseAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "PASTED-1" }),
    );
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "FULFILMENT_RESOLVE_DELIVERED",
        }),
      }),
    );
  });
});

describe("FulfilmentService.check — legacy QUEUED orders", () => {
  // Vendor-accepted long ago but never entered the state machine (the
  // migration backfill was skipped by `prisma db push`).
  const legacy = {
    fulfilmentStatus: "QUEUED",
    createdAt: new Date(Date.now() - 40 * 24 * HOUR),
    expectedBy: null,
    vendorStatusResponse: {
      vendorName: "acmePpob",
      vendorStatusResponse: { cachedBody: true },
    },
  };

  it("a cached delivery is recovered quietly without calling the vendor", async () => {
    const { svc, prisma, adapter, push, refunds } = buildHarness({
      row: legacy,
      cached: { outcome: "delivered", raw: "TOKEN-1" },
    });
    expect(await svc.check("purchase", "pur_1")).toBe("DELIVERED");
    expect(adapter.readCachedStatus).toHaveBeenCalledWith({ cachedBody: true });
    expect(adapter.checkOrder).not.toHaveBeenCalled();
    const delivered = (prisma.purchase.updateMany as AnyFn).mock.calls
      .map((c) => c[0])
      .find((f) => f.data.fulfilmentStatus === "DELIVERED");
    expect(delivered.where.fulfilmentStatus.in).toContain("QUEUED");
    expect(delivered.data.deliveryRaw).toBe("TOKEN-1");
    await flushPush();
    expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
    expect(refunds.refund).not.toHaveBeenCalled();
  });

  it("no usable cache → asks the vendor once; a delivery is applied quietly", async () => {
    const { svc, adapter, push } = buildHarness({
      row: legacy,
      vendor: vendorStatus("delivered", "SERIAL-9"),
    });
    expect(await svc.check("purchase", "pur_1")).toBe("DELIVERED");
    expect(adapter.checkOrder).toHaveBeenCalledWith("TRX1");
    await flushPush();
    expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
  });

  it("anything short of a delivery goes to ops, never an automatic refund", async () => {
    for (const outcome of ["pending", "failed"] as const) {
      const { svc, prisma, push, refunds } = buildHarness({
        row: legacy,
        vendor: vendorStatus(outcome),
      });
      expect(await svc.check("purchase", "pur_1")).toBe("NEEDS_RECONCILE");
      const flip = (prisma.purchase.updateMany as AnyFn).mock.calls
        .map((c) => c[0])
        .find((f) => f.data.fulfilmentStatus === "NEEDS_RECONCILE");
      expect(flip).toBeDefined();
      expect(refunds.refund).not.toHaveBeenCalled();
      await flushPush();
      expect(push.sendFulfilmentPush).not.toHaveBeenCalled();
    }
  });

  it("an unreachable vendor leaves the row QUEUED for the next try", async () => {
    const { svc, prisma } = buildHarness({
      row: legacy,
      vendor: vendorStatus("pending", "", { unavailable: true }),
    });
    expect(await svc.check("purchase", "pur_1")).toBe("QUEUED");
    const statusFlip = (prisma.purchase.updateMany as AnyFn).mock.calls.find(
      (c) => c[0].data.fulfilmentStatus,
    );
    expect(statusFlip).toBeUndefined();
  });
});

describe("FulfilmentService.finishStrandedRefund", () => {
  it("credits an order left at FAILED by an interrupted settle", async () => {
    const h = buildHarness({ row: { fulfilmentStatus: "FAILED" } });
    await h.svc.finishStrandedRefund("purchase", "p1");
    expect(h.refunds.refund).toHaveBeenCalledTimes(1);
    expect(h.refunds.refund).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "purchase", points: 50000n }),
    );
  });

  it.each(["REFUNDED", "DELIVERED", "SUBMITTED"])(
    "does nothing for an order at %s",
    async (fulfilmentStatus) => {
      const h = buildHarness({ row: { fulfilmentStatus } });
      await h.svc.finishStrandedRefund("purchase", "p1");
      expect(h.refunds.refund).not.toHaveBeenCalled();
    },
  );

  it("is reached by a retried settle that finds the order already FAILED", async () => {
    const h = buildHarness({
      row: { fulfilmentStatus: "FAILED" },
      flipCount: 0,
    });
    await h.svc.onOrderRetriesExhausted("purchase", "p1", {
      orderAttempted: false,
      error: "paid after the booking expired",
    });
    expect(h.refunds.refund).toHaveBeenCalledTimes(1);
  });
});
