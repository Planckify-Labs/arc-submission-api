import { PointsHoldService } from "../points-hold/points-hold.service";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  FulfilmentStatus,
  Prisma,
  PurchaseStatus,
  RedemptionStatus,
} from "@generated/prisma";
import { PrismaService } from "../prisma/prisma.service";
import { VendorRegistry } from "../providers/vendor-api/vendor-registry.service";
import type { VendorOrderFailure } from "../providers/vendor-api/base/base-vendor.service";
import {
  TVCgamerResponse,
  TVCGamerOrderResponse,
} from "../providers/vendor-api/types/vcgamer-api.types";
import { DeliveryParserService } from "../delivery/delivery-parser.service";
import {
  DeliveryPayload,
  isVoucherTemplate,
  resolveDeliveryType,
} from "../delivery/delivery.types";
import { PointsRefundService } from "../points/points-refund.service";
import { PushService, FulfilmentPushInput } from "../push/push.service";
import { isLegacyQueued } from "./fulfilment-view";
import {
  FULFILMENT_QUEUE,
  FulfilmentCheckJob,
  FulfilmentKind,
  FulfilmentTarget,
  OPEN_FULFILMENT,
  TERMINAL_FULFILMENT,
} from "./fulfilment.types";

/**
 * Seconds until the next vendor status check, by attempt. Tight at first
 * (most top-ups land in under a minute), then hourly. After the schedule
 * runs out the order is still asked about hourly until `MAX_PENDING_MS`.
 */
export const CHECK_BACKOFF_SECONDS = [
  15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];
/** Pending this long is no longer "slow", it's "unknown" — hand to ops. */
const MAX_PENDING_MS = 24 * 60 * 60 * 1000;
/** When the vendor gives no SLA for a variant. */
const DEFAULT_EXPECTED_SECONDS = 15 * 60;
/** Keep looking for a late delivery this long after a refund (clawback). */
export const POST_REFUND_WATCH_MS = 24 * 60 * 60 * 1000;

/**
 * The fulfilment leg of an order, from "vendor accepted" to "product in
 * the buyer's hands" (or "money back"). Purchases and redemptions share
 * it. Every transition is a compare-and-set on `fulfilmentStatus`, so the
 * poller, the sweeper, the lazy read path and an admin can all observe
 * the same vendor answer without double-delivering or double-refunding.
 *
 * Provider-agnostic: the vendor is resolved per order from
 * `productPrice.vendor.name` and only ever spoken to through the
 * fulfilment port on `BaseVendorService` (`checkOrder`,
 * `classifyOrderFailure`). Status codes and body shapes stay inside the
 * adapters.
 */
@Injectable()
export class FulfilmentService {
  private readonly logger = new Logger(FulfilmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FULFILMENT_QUEUE)
    private readonly queue: Queue<FulfilmentCheckJob>,
    private readonly vendors: VendorRegistry,
    private readonly parser: DeliveryParserService,
    private readonly refunds: PointsRefundService,
    private readonly push: PushService,
    private readonly holds: PointsHoldService,
  ) {}

  // ── entry points for the order workers ─────────────────────────────

  /** The vendor accepted the order (`trx_code` in hand). */
  async onVendorAccepted(kind: FulfilmentKind, id: string): Promise<void> {
    const target = await this.load(kind, id);
    const slaSeconds =
      target.slaSeconds && target.slaSeconds > 0 ? target.slaSeconds : null;
    const expectedBy = new Date(
      Date.now() + (slaSeconds ?? DEFAULT_EXPECTED_SECONDS) * 1000,
    );

    const flipped = await this.flip(kind, id, [FulfilmentStatus.QUEUED], {
      fulfilmentStatus: FulfilmentStatus.SUBMITTED,
      expectedBy,
      fulfilmentError: null,
    });
    if (!flipped) {
      // Already past SUBMITTED (a retry of the worker after the vendor
      // accepted the first time). The poll is scheduled either way.
      this.logger.debug(`[fulfilment] ${kind} ${id} already submitted`);
    } else {
      this.notify(target, {
        stage: "paid",
        expectedMinutes: slaSeconds
          ? Math.max(1, Math.round(slaSeconds / 60))
          : undefined,
      });
    }
    await this.schedule(kind, id, 0);
  }

  /**
   * `createOrder` did not yield an accepted order. Definitive rejections
   * are settled (and refunded) now; ambiguous ones are the caller's to
   * retry — it reports back via `onOrderRetriesExhausted`.
   */
  async onVendorRejected(
    kind: FulfilmentKind,
    id: string,
    resp: TVCgamerResponse<TVCGamerOrderResponse>,
  ): Promise<VendorOrderFailure["cls"]> {
    const target = await this.load(kind, id);
    const { cls, reason } = this.vendors
      .get(target.vendorName)
      .classifyOrderFailure(resp);
    if (cls === "definitive") {
      await this.settleFailed(kind, id, `vendor rejected: ${reason}`, "auto");
    } else {
      this.logger.warn(
        `[fulfilment] ${kind} ${id} ambiguous vendor failure: ${reason}`,
      );
    }
    return cls;
  }

  /**
   * The worker is out of retries. If the vendor was never reached the
   * refund is safe; if an order may exist on their side, ops decides.
   */
  async onOrderRetriesExhausted(
    kind: FulfilmentKind,
    id: string,
    input: { orderAttempted: boolean; error: string },
  ): Promise<void> {
    if (!input.orderAttempted) {
      await this.settleFailed(
        kind,
        id,
        `not sent to vendor: ${input.error}`,
        "auto",
      );
      return;
    }
    await this.markReconcile(
      kind,
      id,
      `vendor outcome unknown: ${input.error}`,
    );
  }

  /**
   * The payment never got a chain verdict within the retry budget (RPC down,
   * receipt not available). We do not know whether the money moved, so this
   * is ops' call: never an automatic refund (points are only refunded for
   * a payment we verified), never a "failed".
   */
  async onPaymentUnverified(
    kind: FulfilmentKind,
    id: string,
    error: string,
  ): Promise<void> {
    await this.markReconcile(kind, id, `payment not verified: ${error}`);
  }

  // ── the poll ───────────────────────────────────────────────────────

  async schedule(
    kind: FulfilmentKind,
    id: string,
    attempt: number,
  ): Promise<void> {
    const delaySec =
      CHECK_BACKOFF_SECONDS[
        Math.min(attempt, CHECK_BACKOFF_SECONDS.length - 1)
      ];
    await this.queue.add(
      "check",
      { kind, id, attempt },
      {
        jobId: `fulfilment-${kind}-${id}-${attempt}`,
        delay: delaySec * 1000,
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 500 },
      },
    );
  }

  /**
   * Ask the vendor once and apply the answer. Called by the poller (with
   * `attempt`, so it can reschedule), by the sweeper, by the read path
   * when a user opens a still-pending order, and by an admin resolve.
   * Returns the status after applying.
   */
  async check(
    kind: FulfilmentKind,
    id: string,
    opts: { attempt?: number; reschedule?: boolean } = {},
  ): Promise<FulfilmentStatus> {
    const target = await this.load(kind, id);

    if (TERMINAL_FULFILMENT.has(target.fulfilmentStatus))
      return target.fulfilmentStatus;
    if (!target.vendorRefId) return target.fulfilmentStatus; // never reached the vendor
    if (isLegacyQueued(target)) return this.recoverLegacy(target);

    // After a refund we still look, but only for a late delivery (clawback).
    if (
      target.fulfilmentStatus === FulfilmentStatus.REFUNDED &&
      Date.now() - target.createdAt.getTime() > POST_REFUND_WATCH_MS
    ) {
      return target.fulfilmentStatus;
    }

    const verdict = await this.vendors
      .get(target.vendorName)
      .checkOrder(target.vendorRefId);
    await this.touch(kind, id);

    if (verdict.unavailable) {
      this.logger.warn(
        `[fulfilment] status check unavailable for ${kind} ${id}: ${verdict.reason ?? "unknown"}`,
      );
      return this.applyPending(target, opts);
    }

    await this.cacheVendorStatus(target, verdict.response);

    switch (verdict.outcome) {
      case "delivered":
        return this.applyDelivered(target, verdict.raw);
      case "failed":
        if (target.fulfilmentStatus === FulfilmentStatus.REFUNDED) {
          return target.fulfilmentStatus;
        }
        await this.settleFailed(
          kind,
          id,
          `vendor failed: ${verdict.reason ?? "unknown"}`,
          "auto",
          target,
        );
        return FulfilmentStatus.FAILED;
      default:
        return this.applyPending(target, opts);
    }
  }

  /** Ops decides an ambiguous order. */
  async resolveManually(
    kind: FulfilmentKind,
    id: string,
    input: {
      outcome: "delivered" | "failed";
      adminId: string;
      note?: string;
      raw?: string;
    },
  ): Promise<FulfilmentStatus> {
    const target = await this.load(kind, id);
    if (input.outcome === "delivered") {
      const status = await this.applyDelivered(target, input.raw ?? null);
      await this.audit(
        input.adminId,
        "FULFILMENT_RESOLVE_DELIVERED",
        kind,
        id,
        input.note,
      );
      return status;
    }
    await this.settleFailed(
      kind,
      id,
      `resolved by ops: ${input.note ?? "no note"}`,
      "admin",
      target,
      input.adminId,
    );
    await this.audit(
      input.adminId,
      "FULFILMENT_RESOLVE_FAILED",
      kind,
      id,
      input.note,
    );
    return FulfilmentStatus.FAILED;
  }

  // ── transitions ────────────────────────────────────────────────────

  private async applyDelivered(
    target: FulfilmentTarget,
    raw: string | null,
    { notify = true }: { notify?: boolean } = {},
  ): Promise<FulfilmentStatus> {
    const delivery = await this.parser.parseAndRecord({
      productCode: target.productCode,
      deliveryType: target.deliveryType,
      raw,
      template: target.voucherTemplate,
      customerInfo: target.customerInfo,
    });
    const now = new Date();

    if (target.fulfilmentStatus === FulfilmentStatus.REFUNDED) {
      // Delivered after we gave the money back. Keep REFUNDED (the ledger
      // is the truth) but record the delivery so ops can claw back.
      await this.update(target.kind, target.id, {
        delivery: delivery as unknown as Prisma.InputJsonValue,
        deliveryRaw: raw,
        deliveredAfterRefundAt: now,
      });
      this.logger.warn(
        `[fulfilment] ${target.kind} ${target.id} DELIVERED AFTER REFUND — clawback queue`,
      );
      return FulfilmentStatus.REFUNDED;
    }

    const flipped = await this.flip(target.kind, target.id, OPEN_FULFILMENT, {
      fulfilmentStatus: FulfilmentStatus.DELIVERED,
      fulfilledAt: now,
      fulfilmentError: null,
      delivery: delivery as unknown as Prisma.InputJsonValue,
      deliveryRaw: raw,
      ...this.moneyLeg(target.kind, "completed"),
    });
    if (flipped && notify) {
      this.notify(target, {
        stage: "delivered",
        deliveryKind: delivery.kind,
        target: delivery.target,
      });
      this.logger.log(
        `[fulfilment] ${target.kind} ${target.id} delivered (${delivery.parse})`,
      );
    }
    return FulfilmentStatus.DELIVERED;
  }

  private async settleFailed(
    kind: FulfilmentKind,
    id: string,
    reason: string,
    source: "auto" | "admin",
    loaded?: FulfilmentTarget,
    adminId?: string,
  ): Promise<void> {
    const target = loaded ?? (await this.load(kind, id));
    const flipped = await this.flip(kind, id, OPEN_FULFILMENT, {
      fulfilmentStatus: FulfilmentStatus.FAILED,
      fulfilmentError: reason.slice(0, 500),
      ...this.moneyLeg(kind, "failed"),
    });
    if (!flipped) {
      this.logger.debug(
        `[fulfilment] ${kind} ${id} not open, skip settleFailed`,
      );
      // A retry can land here after the run that flipped it died mid-refund.
      await this.finishStrandedRefund(kind, id);
      return;
    }
    this.logger.warn(`[fulfilment] ${kind} ${id} FAILED: ${reason}`);
    await this.issueRefund(kind, id, target, reason, source, adminId);
  }

  /**
   * Completes the refund for an order left at FAILED by an interrupted
   * settle: the status flip and the credit are separate writes, and only
   * `settleFailed` sets FAILED, so FAILED without a refund row means the
   * credit never landed. Safe to repeat: the credit is a compare-and-set from
   * FAILED and `FulfilmentRefund` is unique per order.
   */
  async finishStrandedRefund(kind: FulfilmentKind, id: string): Promise<void> {
    const target = await this.load(kind, id);
    if (target.fulfilmentStatus !== FulfilmentStatus.FAILED) return;
    await this.issueRefund(
      kind,
      id,
      target,
      "refund retried after an interrupted settle",
      "auto",
    );
  }

  private async issueRefund(
    kind: FulfilmentKind,
    id: string,
    target: FulfilmentTarget,
    reason: string,
    source: "auto" | "admin",
    adminId?: string,
  ): Promise<void> {
    const amount = await this.refundAmount(target);
    const userId = target.userId ?? (await this.userIdFor(target));
    if (!userId) {
      this.logger.error(
        `[fulfilment] ${kind} ${id} has no user to refund — needs ops`,
      );
      return;
    }
    const result = await this.refunds.refund({
      kind,
      id,
      userId,
      points: amount.points,
      fiatAmount: amount.fiatAmount,
      currency: amount.currency,
      reason,
      source,
      adminId,
      productCode: target.productCode,
      notify: {
        userId: target.userId ?? undefined,
        walletAddress: target.walletAddress ?? undefined,
        productName: target.productName,
      },
    });
    this.logger.log(
      `[fulfilment] refund for ${kind} ${id}: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }

  private async markReconcile(
    kind: FulfilmentKind,
    id: string,
    reason: string,
    { notify = true }: { notify?: boolean } = {},
  ) {
    const target = await this.load(kind, id);
    const flipped = await this.flip(
      kind,
      id,
      [
        FulfilmentStatus.QUEUED,
        FulfilmentStatus.SUBMITTED,
        FulfilmentStatus.DELAYED,
      ],
      {
        fulfilmentStatus: FulfilmentStatus.NEEDS_RECONCILE,
        fulfilmentError: reason.slice(0, 500),
      },
    );
    if (flipped) {
      this.logger.error(
        `[fulfilment] ${kind} ${id} NEEDS_RECONCILE: ${reason}`,
      );
      if (notify) this.notify(target, { stage: "reconcile" });
    }
  }

  /**
   * A vendor-accepted order that never entered this state machine (see
   * `isLegacyQueued`). The buyer was told about it at the time, so this is
   * quiet: no pushes. The adapter's cached answer wins when it shows a
   * delivery (the vendor may no longer answer for old orders); otherwise
   * ask once. Anything short of a delivery goes to ops, never an automatic
   * refund of an old order.
   */
  private async recoverLegacy(
    target: FulfilmentTarget,
  ): Promise<FulfilmentStatus> {
    const adapter = this.vendors.get(target.vendorName);
    const cached =
      adapter.readCachedStatus?.(target.cachedVendorStatus) ?? null;
    if (cached?.outcome === "delivered") {
      return this.applyDelivered(target, cached.raw, { notify: false });
    }

    const live = await adapter.checkOrder(target.vendorRefId as string);
    await this.touch(target.kind, target.id);
    if (live.unavailable) {
      this.logger.warn(
        `[fulfilment] legacy ${target.kind} ${target.id}: status check unavailable: ${live.reason ?? "unknown"}`,
      );
      return target.fulfilmentStatus;
    }
    await this.cacheVendorStatus(target, live.response);
    if (live.outcome === "delivered") {
      return this.applyDelivered(target, live.raw, { notify: false });
    }
    await this.markReconcile(
      target.kind,
      target.id,
      `legacy order, vendor says ${live.outcome}${live.reason ? `: ${live.reason}` : ""}`,
      { notify: false },
    );
    return FulfilmentStatus.NEEDS_RECONCILE;
  }

  private async applyPending(
    target: FulfilmentTarget,
    opts: { attempt?: number; reschedule?: boolean },
  ): Promise<FulfilmentStatus> {
    const now = Date.now();
    let status = target.fulfilmentStatus;

    if (status === FulfilmentStatus.REFUNDED) {
      // Only watching for a late delivery; no nagging pushes, no reconcile.
      if (opts.reschedule !== false && opts.attempt !== undefined) {
        await this.schedule(target.kind, target.id, opts.attempt + 1);
      }
      return status;
    }

    if (now - target.createdAt.getTime() > MAX_PENDING_MS) {
      await this.markReconcile(
        target.kind,
        target.id,
        "vendor still pending after 24h",
      );
      return FulfilmentStatus.NEEDS_RECONCILE;
    }

    if (
      status === FulfilmentStatus.SUBMITTED &&
      target.expectedBy &&
      now > target.expectedBy.getTime()
    ) {
      const flipped = await this.flip(
        target.kind,
        target.id,
        [FulfilmentStatus.SUBMITTED],
        {
          fulfilmentStatus: FulfilmentStatus.DELAYED,
        },
      );
      if (flipped) {
        status = FulfilmentStatus.DELAYED;
        this.notify(target, { stage: "delayed" });
      }
    }

    if (opts.reschedule !== false && opts.attempt !== undefined) {
      await this.schedule(target.kind, target.id, opts.attempt + 1);
    }
    return status;
  }

  // ── persistence helpers ────────────────────────────────────────────

  async load(kind: FulfilmentKind, id: string): Promise<FulfilmentTarget> {
    if (kind === "purchase") {
      const p = await this.prisma.purchase.findUnique({
        where: { id },
        include: {
          bookingOrder: {
            select: {
              walletAddress: true,
              customerInfo: true,
              productPrice: { select: { vendor: { select: { name: true } } } },
            },
          },
          productVariant: {
            select: {
              name: true,
              slaSeconds: true,
              product: {
                select: {
                  code: true,
                  name: true,
                  isVoucher: true,
                  deliveryType: true,
                  voucherTemplate: true,
                },
              },
            },
          },
        },
      });
      if (!p) throw new NotFoundException(`Purchase ${id} not found`);
      return {
        kind,
        id,
        fulfilmentStatus: p.fulfilmentStatus,
        vendorRefId: p.vendorRefId,
        createdAt: p.createdAt,
        expectedBy: p.expectedBy,
        vendorCheckCount: p.vendorCheckCount,
        userId: null,
        walletAddress: p.bookingOrder.walletAddress,
        vendorName: p.bookingOrder.productPrice.vendor.name,
        productCode: p.productVariant.product.code,
        productName: p.productVariant.product.name,
        deliveryType: resolveDeliveryType(p.productVariant.product),
        voucherTemplate: isVoucherTemplate(
          p.productVariant.product.voucherTemplate,
        )
          ? p.productVariant.product.voucherTemplate
          : null,
        slaSeconds: p.productVariant.slaSeconds,
        customerInfo: p.bookingOrder.customerInfo,
        // `cacheVendorStatus` wraps the purchase body with the vendor name.
        cachedVendorStatus:
          (p.vendorStatusResponse as { vendorStatusResponse?: unknown } | null)
            ?.vendorStatusResponse ?? null,
      };
    }

    const r = await this.prisma.pointRedemption.findUnique({
      where: { id },
      include: {
        productPrice: { select: { vendor: { select: { name: true } } } },
        productVariant: {
          select: {
            name: true,
            slaSeconds: true,
            product: {
              select: {
                code: true,
                name: true,
                isVoucher: true,
                deliveryType: true,
                voucherTemplate: true,
              },
            },
          },
        },
      },
    });
    if (!r) throw new NotFoundException(`Redemption ${id} not found`);
    return {
      kind,
      id,
      fulfilmentStatus: r.fulfilmentStatus,
      vendorRefId: r.vendorRefId,
      createdAt: r.createdAt,
      expectedBy: r.expectedBy,
      vendorCheckCount: r.vendorCheckCount,
      userId: r.userId,
      walletAddress: null,
      vendorName: r.productPrice.vendor.name,
      productCode: r.productVariant.product.code,
      productName:
        `${r.productVariant.product.name} ${r.productVariant.name}`.trim(),
      deliveryType: resolveDeliveryType(r.productVariant.product),
      voucherTemplate: isVoucherTemplate(
        r.productVariant.product.voucherTemplate,
      )
        ? r.productVariant.product.voucherTemplate
        : null,
      slaSeconds: r.productVariant.slaSeconds,
      customerInfo: r.customerInfo,
      cachedVendorStatus: r.vendorResponse,
    };
  }

  /** CAS: apply `data` only if the row is in one of `from`. */
  private async flip(
    kind: FulfilmentKind,
    id: string,
    from: FulfilmentStatus[],
    data: Prisma.PurchaseUpdateManyMutationInput &
      Prisma.PointRedemptionUpdateManyMutationInput,
  ): Promise<boolean> {
    const r =
      kind === "purchase"
        ? await this.prisma.purchase.updateMany({
            where: { id, fulfilmentStatus: { in: from } },
            data,
          })
        : await this.prisma.pointRedemption.updateMany({
            where: { id, fulfilmentStatus: { in: from } },
            data,
          });
    return r.count === 1;
  }

  private async update(
    kind: FulfilmentKind,
    id: string,
    data: Prisma.PurchaseUpdateManyMutationInput &
      Prisma.PointRedemptionUpdateManyMutationInput,
  ) {
    if (kind === "purchase") {
      await this.prisma.purchase.updateMany({ where: { id }, data });
    } else {
      await this.prisma.pointRedemption.updateMany({ where: { id }, data });
    }
  }

  private async touch(kind: FulfilmentKind, id: string) {
    await this.update(kind, id, {
      vendorLastCheckedAt: new Date(),
      vendorCheckCount: { increment: 1 },
    });
  }

  /**
   * The money leg mirrors the outcome so existing readers (mobile's
   * `purchase.status`, admin lists, stats) see it without knowing about
   * the fulfilment leg.
   */
  private moneyLeg(kind: FulfilmentKind, outcome: "completed" | "failed") {
    if (kind === "purchase") {
      return {
        status:
          outcome === "completed"
            ? PurchaseStatus.COMPLETED
            : PurchaseStatus.FAILED,
      };
    }
    return {
      status:
        outcome === "completed"
          ? RedemptionStatus.COMPLETED
          : RedemptionStatus.FAILED,
    };
  }

  /**
   * Keep the vendor's answer in the shape each read path already parses:
   * purchases wrap it, redemptions store the body as-is.
   */
  private async cacheVendorStatus(target: FulfilmentTarget, body: unknown) {
    try {
      if (target.kind === "purchase") {
        await this.prisma.purchase.update({
          where: { id: target.id },
          data: {
            vendorStatusResponse: {
              vendorName: target.vendorName,
              vendorStatusResponse: body,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        await this.prisma.pointRedemption.update({
          where: { id: target.id },
          data: { vendorResponse: body as unknown as Prisma.InputJsonValue },
        });
      }
    } catch (err) {
      this.logger.warn(
        `[fulfilment] could not cache vendor status for ${target.kind} ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 1 point = Rp 1 (`redeem.service`), so the refund is the IDR amount
   * from the locked record. Anything that would need a live rate is left
   * for a human (`points: null` → held).
   */
  private async refundAmount(target: FulfilmentTarget): Promise<{
    points: bigint | null;
    fiatAmount: string | null;
    currency: string | null;
  }> {
    if (target.kind === "redemption") {
      const r = await this.prisma.pointRedemption.findUnique({
        where: { id: target.id },
        select: { pointsSpent: true },
      });
      return {
        points: r?.pointsSpent ?? null,
        fiatAmount: null,
        currency: null,
      };
    }

    const p = await this.prisma.purchase.findUnique({
      where: { id: target.id },
      select: {
        transactionId: true,
        transactionCreatedAt: true,
        bookingOrder: {
          select: {
            id: true,
            pointsApplied: true,
            productPrice: { select: { sellPrice: true, currency: true } },
          },
        },
      },
    });
    if (!p) return { points: null, fiatAmount: null, currency: null };

    // Part of the price may have been paid with held points. Whatever
    // settles this order must hand them back too, exactly once: first
    // HELD -> CONSUMED (idempotent; a no-op for bookings without points),
    // then the points come back only if the hold is ours (CONSUMED). A hold
    // the sweep already released was credited back then, so only the token
    // part remains owed. Deterministic on repeat, so an interrupted settle
    // (`finishStrandedRefund`) computes the same amount.
    const held = p.bookingOrder.pointsApplied ?? 0n;
    let pointsPart = 0n;
    if (held > 0n) {
      const hold = await this.holds.consume(p.bookingOrder.id);
      if (hold === "CONSUMED") pointsPart = held;
    }

    const tx = await this.prisma.transactionHistory.findFirst({
      where: { id: p.transactionId, createdAt: p.transactionCreatedAt },
      select: { amountInFiat: true, fiatCurrency: true },
    });
    const ceil = (v: Prisma.Decimal | string | number) =>
      BigInt(new Prisma.Decimal(v.toString()).ceil().toFixed(0));
    const total = (tokenPart: Prisma.Decimal | string | number) =>
      new Prisma.Decimal(tokenPart.toString())
        .add(pointsPart.toString())
        .toString();

    // `amountInFiat` is already the token part (price minus points applied).
    if (tx && tx.fiatCurrency === "IDR" && tx.amountInFiat) {
      return {
        points: ceil(tx.amountInFiat) + pointsPart,
        fiatAmount: total(tx.amountInFiat),
        currency: "IDR",
      };
    }
    const price = p.bookingOrder.productPrice;
    if (price.currency === "IDR") {
      const tokenPart = new Prisma.Decimal(price.sellPrice.toString()).sub(
        held.toString(),
      );
      return {
        points: ceil(tokenPart) + pointsPart,
        fiatAmount: total(tokenPart),
        currency: "IDR",
      };
    }
    return {
      points: null,
      fiatAmount: tx?.amountInFiat?.toString() ?? null,
      currency: tx?.fiatCurrency ?? price.currency,
    };
  }

  private async userIdFor(target: FulfilmentTarget): Promise<string | null> {
    if (target.kind !== "purchase") return target.userId;
    const p = await this.prisma.purchase.findUnique({
      where: { id: target.id },
      select: { transactionId: true, transactionCreatedAt: true },
    });
    if (!p) return null;
    const tx = await this.prisma.transactionHistory.findFirst({
      where: { id: p.transactionId, createdAt: p.transactionCreatedAt },
      select: { userId: true },
    });
    return tx?.userId ?? null;
  }

  private notify(
    target: FulfilmentTarget,
    input: Omit<
      FulfilmentPushInput,
      "kind" | "id" | "productName" | "userId" | "walletAddress"
    >,
  ) {
    void this.push
      .sendFulfilmentPush({
        userId: target.userId ?? undefined,
        walletAddress: target.walletAddress ?? undefined,
        kind: target.kind,
        id: target.id,
        productName: target.productName,
        ...input,
      })
      .catch((err) =>
        this.logger.warn(
          `[fulfilment] push ${input.stage} failed for ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private async audit(
    adminId: string,
    action: string,
    kind: FulfilmentKind,
    id: string,
    note?: string,
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        adminUser: { connect: { id: adminId } },
        action,
        resource: kind === "purchase" ? "Purchase" : "PointRedemption",
        resourceId: id,
        metadata: { note: note ?? null } as Prisma.InputJsonValue,
      },
    });
  }
}

export type { DeliveryPayload };
