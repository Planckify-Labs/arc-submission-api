import type { Prisma } from "@generated/prisma";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Job, Queue } from "bullmq";
import {
  Expo,
  type ExpoPushErrorReceipt,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from "expo-server-sdk";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { canonicalizeWalletAddress, truncateAddress } from "../utils/address";
import {
  defaultChannelFor,
  NotificationCategory,
  resolveCategory,
} from "./notification-categories";
import { NotificationPreferencesService } from "./notification-preferences.service";
import {
  WALLET_ACTIVITY_QUEUE,
  type WalletActivityJobData,
} from "../wallet-activity/wallet-activity.types";

export const PUSH_DISPATCH_QUEUE = "push-dispatch";
export const PUSH_RECEIPTS_QUEUE = "push-receipts";

/**
 * Lifecycle of a `NotificationLog` row.
 *
 *   queued ──► sending ──► pending ──► delivered | undelivered | unregistered
 *     ▲           │
 *     └───────────┘  (devices still pending → back to queued for the next attempt)
 *
 * Short-cuts: `no_device` (nothing subscribed when staged), `failed` (every
 * attempt exhausted without a single accepted ticket), `expired` (`expiresAt`
 * passed before a worker got to it), `muted` (the user has the category
 * switched off — recorded for audit, never sent, hidden from the inbox).
 */
export const PushDeliveryStatus = {
  queued: "queued",
  sending: "sending",
  pending: "pending",
  delivered: "delivered",
  undelivered: "undelivered",
  unregistered: "unregistered",
  no_device: "no_device",
  failed: "failed",
  expired: "expired",
  muted: "muted",
} as const;
export type PushDeliveryStatus =
  (typeof PushDeliveryStatus)[keyof typeof PushDeliveryStatus];

/** One outstanding delivery to verify once Expo's receipt is ready. */
export interface PushReceiptEntry {
  ticketId: string;
  deviceId: string;
  token: string;
  notificationLogId: string;
}

export interface PushDispatchJobData {
  notificationLogId: string;
}

export interface SendPushArgs {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android channel id; iOS ignores. */
  channelId?: string;
  /**
   * Big-picture/rich-content image (e.g. a token logo). Renders natively
   * on Android via expo-notifications. iOS needs a Notification Service
   * Extension to download and attach it — not configured in this app yet,
   * so this is a no-op there until that's added.
   */
  imageUrl?: string;
  /** Recorded in NotificationLog for audit/debug. */
  source?: string;
  /**
   * Give up (status `expired`) if Expo hasn't accepted the push within this
   * many seconds of staging. Omit for "always deliver, however late" — the
   * right default for money ("you received 5 USDC" is still news an hour
   * later); set it for pushes tied to something that itself expires.
   */
  ttlSeconds?: number;
  /**
   * What kind of notification this is, for the user's mute switches and
   * the inbox filter. Omitted = derived from `channelId` (see
   * notification-categories.ts); a push with neither is always sent.
   */
  category?: NotificationCategory;
  /**
   * Producer-agnostic identity of the event being announced. Two stagings
   * with the same key are ONE notification: the second is dropped at the
   * unique index, whichever producer got there first (the sender's app
   * recording a transfer vs. the Zerion webhook seeing it on-chain).
   */
  dedupeKey?: string;
}

export interface SendToUserArgs extends SendPushArgs {
  userId: string;
}

export interface SendToWalletArgs extends SendPushArgs {
  walletAddress: string;
}

/**
 * What a caller learns synchronously. Delivery itself is asynchronous and
 * verified later (`deliveryStatus` on the log row); `attempted` is the one
 * fact known up front — how many devices the target resolved to.
 */
export interface SendPushResult {
  attempted: number;
  /** `null` when the outbox row could not be written, or was deduplicated. */
  notificationLogId: string | null;
  /** True when `dedupeKey` matched an existing row — nothing was staged. */
  deduplicated?: boolean;
  /** True when the user has this category off — recorded, not sent. */
  muted?: boolean;
}

/**
 * "Rp 48.888" — the grouping mobile already uses for IDR (dots, no
 * decimals). Other currencies fall back to a plain `CODE amount`; minor
 * units are assumed to be 2-decimal there.
 */
export type FulfilmentPushStage =
  | "paid"
  | "delivered"
  | "delayed"
  | "reconcile"
  | "refunded"
  | "refund_pending"
  | "refund_reversed";

export interface FulfilmentPushInput {
  userId?: string;
  walletAddress?: string;
  kind: "purchase" | "redemption";
  id: string;
  productName: string;
  stage: FulfilmentPushStage;
  /** For `delivered`: how the product was handed over. */
  deliveryKind?: "voucher" | "topup" | "bill" | "email";
  /** For `delivered` top-ups/emails: where it went ("0812…", "a@b.c"). */
  target?: string;
  /** For `paid`: the vendor SLA, if known. */
  expectedMinutes?: number;
  /** For refund stages. */
  points?: bigint;
}

const POINTS_FORMAT = new Intl.NumberFormat("en-US");

/** Pure so the copy can be unit-tested without a push pipeline. */
export function fulfilmentPushCopy(
  input: FulfilmentPushInput,
): { title: string; body: string } | null {
  const name = input.productName;
  const pts =
    input.points !== undefined ? POINTS_FORMAT.format(input.points) : "";
  switch (input.stage) {
    case "paid":
      return {
        title: "Payment received",
        body: input.expectedMinutes
          ? `We're preparing your ${name}. Usually ready within ${input.expectedMinutes} minute${input.expectedMinutes === 1 ? "" : "s"}.`
          : `We're preparing your ${name}. We'll let you know the moment it's ready.`,
      };
    case "delivered":
      switch (input.deliveryKind) {
        case "topup":
          return {
            title: `${name} delivered`,
            body: input.target
              ? `Sent to ${input.target}. Tap to see the details.`
              : "It's in your account. Tap to see the details.",
          };
        case "bill":
          return {
            title: `${name} paid`,
            body: "Your bill is settled. Tap for the receipt.",
          };
        case "email":
          return {
            title: `${name} is on its way`,
            body: input.target
              ? `The provider is emailing it to ${input.target}. Check spam if it's not there in a few minutes.`
              : "The provider is emailing it to you. Check spam if it's not there in a few minutes.",
          };
        default:
          return {
            title: `Your ${name} code is ready`,
            body: "Tap to view and copy your code.",
          };
      }
    case "delayed":
      return {
        title: "Taking longer than usual",
        body: `${name} is still being processed by the provider. We're on it and will update you.`,
      };
    case "reconcile":
      return {
        title: "We're checking your order",
        body: `${name} needs a manual check. Your money is safe — we'll update you within 24 hours.`,
      };
    case "refunded":
      return {
        title: pts ? `Refunded: ${pts} points` : "Refunded",
        body: `We couldn't deliver ${name}. ${pts ? `${pts} points are` : "Your points are"} back in your balance — you can retry with points anytime.`,
      };
    case "refund_pending":
      return {
        title: "Refund in review",
        body: `We couldn't deliver ${name}. Your refund is being reviewed — usually within 24 hours.`,
      };
    case "refund_reversed":
      return {
        title: `${name} was delivered`,
        body: `It arrived after we refunded you, so ${pts || "the"} points were deducted again. Tap to see the details.`,
      };
    default:
      return null;
  }
}

export function formatFiatMinor(minor: number, currency: string): string {
  const whole = Math.max(0, Math.floor(minor));
  if (currency === "IDR") {
    return `Rp ${whole.toLocaleString("en-US").replace(/,/g, ".")}`;
  }
  return `${currency} ${(whole / 100).toFixed(2)}`;
}

/**
 * Settlement micros → "2.97". Intents store the amount as 6-decimal micros
 * of the settlement token regardless of its symbol or on-chain decimals.
 */
export function formatTokenMicros(micros: bigint): string {
  const n = Number(micros) / 1_000_000;
  if (!Number.isFinite(n)) return micros.toString();
  return n.toFixed(n < 1 ? 4 : 2);
}

export type Device = { id: string; token: string };
type DeliveryOutcome = "done" | "retry" | "skipped";
/** Any Prisma client — the caller's open transaction or the service one. */
type Db = Prisma.TransactionClient;

const DEVICE_SELECT = { id: true, token: true } as const;

/**
 * Expo ticket errors worth another attempt. Everything else at ticket level
 * (`MessageTooBig`, `InvalidCredentials`, `MismatchSenderId`, …) is a
 * property of the message or our credentials — resending the same thing
 * would fail the same way.
 */
const RETRYABLE_TICKET_ERRORS = new Set<string>(["MessageRateExceeded"]);

/**
 * How long `enqueue` waits on Redis before sending inline instead. BullMQ
 * connections run with `maxRetriesPerRequest: null` (required for workers),
 * which means `queue.add` blocks for as long as Redis is unreachable rather
 * than throwing — so a caller that awaited it would hang with the user's
 * push in limbo.
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

/** Sweeper thresholds — see `sweepOutbox`. */
const SWEEP_NEVER_PICKED_UP_MS = 2 * 60_000;
const SWEEP_STUCK_SENDING_MS = 10 * 60_000;
const SWEEP_RETRY_ORPHANED_MS = 15 * 60_000;
const SWEEP_BATCH = 200;

/**
 * Registration of a wallet that a concurrent registration from the same
 * device just created is kept even if this request's list omits it. Two
 * cold-start registrations can race (the wallet list hydrating in steps,
 * a foreground retry) and land out of order; without this window the older
 * request's shorter list would delete a subscription the newer one made
 * and the wallet would silently stop receiving pushes until the next cold
 * start.
 */
const SUBSCRIPTION_KEEP_RECENT_MS = 60_000;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo: Expo;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly preferences: NotificationPreferencesService,
    @InjectQueue(PUSH_DISPATCH_QUEUE)
    private readonly dispatchQueue: Queue<PushDispatchJobData>,
    @InjectQueue(PUSH_RECEIPTS_QUEUE)
    private readonly receiptQueue: Queue<{ entries: PushReceiptEntry[] }>,
    /**
     * Hands freshly registered wallets to the Zerion subscription (see
     * wallet-activity/). Optional so the service stands alone in tests and
     * in any deployment that leaves the wallet-activity feature out.
     */
    @Optional()
    @InjectQueue(WALLET_ACTIVITY_QUEUE)
    private readonly walletActivityQueue?: Queue<WalletActivityJobData>,
  ) {
    const accessToken = this.configService.get<string>("EXPO_ACCESS_TOKEN");
    this.expo = new Expo({
      accessToken:
        accessToken && accessToken.length > 0 ? accessToken : undefined,
    });
    if (!accessToken) {
      this.logger.log(
        "EXPO_ACCESS_TOKEN not set — using anonymous Expo Push relay (rate-limited per source IP).",
      );
    }
  }

  /**
   * Register (or re-register) a device and its wallet subscriptions.
   * Idempotent — upserts the DevicePushToken, then reconciles the
   * WalletPushSubscription rows for that device to the given list so the
   * server is authoritative from the last successful call.
   *
   * `userId` is optional — the endpoint is public (API-key gated) so a
   * device can register before the user signs in, keyed only by wallet
   * address. If a userId is later presented (user signed in on a
   * subsequent call), it gets attached to the existing row; we never
   * clear an already-known userId back to null on an anonymous call.
   */
  async registerToken(input: {
    userId: string | null;
    token: string;
    platform: string;
    wallets: string[];
  }): Promise<{
    deviceId: string;
    wallets: string[];
    isNewDevice: boolean;
  } | null> {
    if (!Expo.isExpoPushToken(input.token)) {
      this.logger.warn(
        `[registerToken] rejected: not a valid Expo push token (user=${input.userId ?? "anonymous"})`,
      );
      return null;
    }

    // "New device" = this push token has never been seen. A reinstall or a
    // token rotation looks the same from here, which is fine: both mean the
    // wallet is now live somewhere the user's OTHER devices didn't know
    // about, and that is exactly what the security push is for.
    const seenBefore = await this.prisma.devicePushToken.findUnique({
      where: { token: input.token },
      select: { id: true },
    });

    const device = await this.prisma.devicePushToken.upsert({
      where: { token: input.token },
      create: {
        token: input.token,
        userId: input.userId,
        platform: input.platform,
      },
      update: {
        ...(input.userId ? { userId: input.userId } : {}),
        platform: input.platform,
        failCount: 0,
      },
    });

    // Canonical per-chain form (never a blanket lowercase, which would
    // corrupt case-sensitive Solana/Stellar addresses).
    const unique = [
      ...new Set(
        input.wallets
          .map((w) => (typeof w === "string" ? w.trim() : ""))
          .filter(Boolean)
          .map((w) => canonicalizeWalletAddress(w)),
      ),
    ];

    // Reconcile rather than wipe-and-recreate: rows for wallets still on
    // the device are left alone (no window where the device has zero
    // subscriptions), rows for wallets the device dropped go, and rows a
    // concurrent registration created moments ago survive an out-of-order
    // arrival. `skipDuplicates` makes two racing registrations of the same
    // list both succeed instead of one 500-ing on the unique key.
    await this.prisma.$transaction([
      this.prisma.walletPushSubscription.deleteMany({
        where: {
          deviceTokenId: device.id,
          ...(unique.length > 0 ? { walletAddress: { notIn: unique } } : {}),
          createdAt: { lt: new Date(Date.now() - SUBSCRIPTION_KEEP_RECENT_MS) },
        },
      }),
      ...(unique.length > 0
        ? [
            this.prisma.walletPushSubscription.createMany({
              data: unique.map((walletAddress) => ({
                deviceTokenId: device.id,
                walletAddress,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    this.logger.log(
      `[registerToken] upserted device=${device.id} user=${input.userId ?? "anonymous"} wallets=${unique.length}`,
    );

    if (unique.length > 0) this.subscribeWalletActivity(device.id, unique);

    const isNewDevice = !seenBefore;
    if (isNewDevice && unique.length > 0) {
      // Best-effort, after the registration is committed: the push goes to
      // the wallet's other devices, never to the one that just registered.
      void this.sendNewDevicePush({
        deviceId: device.id,
        platform: input.platform,
        wallets: unique,
      }).catch((err) => {
        this.logger.warn(
          `[registerToken] new-device push failed for device=${device.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return { deviceId: device.id, wallets: unique, isNewDevice };
  }

  /**
   * Ask the wallet-activity worker to add these wallets to the Zerion
   * subscription. Fire-and-forget: the 6-hourly reconcile catches anything
   * a missed job leaves out, and registration must never wait on Redis.
   */
  private subscribeWalletActivity(deviceId: string, wallets: string[]): void {
    if (!this.walletActivityQueue) return;
    const fingerprint = createHash("sha1")
      .update([...wallets].sort().join(","))
      .digest("hex")
      .slice(0, 12);
    void this.walletActivityQueue
      .add(
        "subscribe",
        { kind: "subscribe", wallets },
        { jobId: `subscribe:${deviceId}:${fingerprint}` },
      )
      .catch((err) => {
        this.logger.warn(
          `[registerToken] could not queue wallet-activity subscribe for device=${deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * "Your wallet is now on a new device" to every OTHER device that holds
   * one of the wallets the new device registered. One push per wallet
   * (each wallet's holders may differ), keyed so a registration retry
   * can't ring twice.
   */
  private async sendNewDevicePush(input: {
    deviceId: string;
    platform: string;
    wallets: string[];
  }): Promise<void> {
    const platformWord =
      input.platform.toLowerCase() === "ios"
        ? "iPhone"
        : input.platform.toLowerCase() === "android"
          ? "Android device"
          : "device";
    for (const wallet of input.wallets) {
      const devices = (
        await this.resolveWalletDevices(wallet, this.prisma)
      ).filter((d) => d.id !== input.deviceId);
      if (devices.length === 0) continue;
      const staged = await this.stage(
        devices,
        {
          title: "Wallet active on a new device",
          body: `${truncateAddress(wallet)} was just set up on a new ${platformWord}. If this wasn't you, move your funds to a new wallet right away.`,
          category: NotificationCategory.security,
          channelId: "security",
          source: "new_device",
          dedupeKey: `new-device:${input.deviceId}:${wallet}`,
          data: {
            type: "new_device",
            walletAddress: wallet,
            platform: input.platform,
          },
        },
        { walletAddress: wallet },
        this.prisma,
      );
      await this.enqueue(staged);
    }
  }

  // ─── public send API ─────────────────────────────────────────────────────
  //
  // Every send is two phases: `stage*` writes the outbox row (optionally
  // inside the caller's own DB transaction, so the push is committed
  // atomically with whatever it announces), `enqueue` hands it to the
  // dispatch worker. `send*` is the one-shot convenience for callers with
  // no transaction of their own.

  /** Send a push to every device registered to a user. */
  async sendToUser(args: SendToUserArgs): Promise<SendPushResult> {
    const staged = await this.stageToUser(args);
    await this.enqueue(staged);
    return staged;
  }

  /** Send a push to every device subscribed to a wallet address. */
  async sendToWallet(args: SendToWalletArgs): Promise<SendPushResult> {
    const staged = await this.stageToWallet(args);
    await this.enqueue(staged);
    return staged;
  }

  /**
   * Send a push to specific Expo tokens (the WalletConnect push server
   * maps relay client ids to tokens itself). Unknown tokens are skipped:
   * delivery bookkeeping (receipts, pruning) hangs off DevicePushToken.
   */
  async sendToTokens(
    tokens: string[],
    args: SendPushArgs,
  ): Promise<SendPushResult> {
    const staged = await this.stageToTokens(tokens, args);
    await this.enqueue(staged);
    return staged;
  }

  /** Phase 1 of `sendToUser` — see the section comment above. */
  async stageToUser(
    args: SendToUserArgs,
    db: Db = this.prisma,
  ): Promise<SendPushResult> {
    const devices = await this.resolveUserDevices(args.userId, db);
    return this.stage(devices, args, { userId: args.userId }, db);
  }

  /** Phase 1 of `sendToWallet`. */
  async stageToWallet(
    args: SendToWalletArgs,
    db: Db = this.prisma,
  ): Promise<SendPushResult> {
    const canonical = canonicalizeWalletAddress(args.walletAddress);
    const devices = await this.resolveWalletDevices(canonical, db);
    return this.stage(devices, args, { walletAddress: canonical }, db);
  }

  /** Phase 1 of `sendToTokens`. */
  async stageToTokens(
    tokens: string[],
    args: SendPushArgs,
    db: Db = this.prisma,
  ): Promise<SendPushResult> {
    const devices =
      tokens.length === 0
        ? []
        : await db.devicePushToken.findMany({
            where: { token: { in: tokens } },
            select: DEVICE_SELECT,
          });
    return this.stage(devices, args, {}, db);
  }

  /**
   * Phase 2: hand a staged row to the dispatch worker. Call after the
   * caller's transaction has committed — the worker reads the row by id.
   * Idempotent: the job id is the row id, so BullMQ de-duplicates repeats,
   * and the worker's status CAS de-duplicates the rest.
   *
   * If Redis can't take the job promptly, the push is attempted inline so
   * the user still gets it now; the committed row keeps the sweeper as the
   * safety net if that also fails.
   */
  async enqueue(staged: SendPushResult): Promise<void> {
    const { notificationLogId, attempted } = staged;
    if (!notificationLogId || attempted === 0) return;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`queue.add timed out after ${ENQUEUE_TIMEOUT_MS}ms`),
          ),
        ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        this.dispatchQueue.add(
          "dispatch",
          { notificationLogId },
          { jobId: notificationLogId },
        ),
        timeout,
      ]);
    } catch (err) {
      this.logger.warn(
        `[enqueue] could not queue push ${notificationLogId} (${err instanceof Error ? err.message : String(err)}); sending inline`,
      );
      await this.attemptDelivery(notificationLogId, { final: false }).catch(
        (inlineErr) => {
          this.logger.warn(
            `[enqueue] inline send of ${notificationLogId} failed: ${inlineErr instanceof Error ? inlineErr.message : String(inlineErr)}`,
          );
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── payment-specific pushes ─────────────────────────────────────────────

  /**
   * Send a PAID_OUT receipt push for a payment intent. Looks up the
   * payer and merchant, then fans out to all devices registered by
   * that user.
   */
  async sendPaidOutPush(intentId: string): Promise<void> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: {
        payerUserId: true,
        fiatAmountMinor: true,
        fiatCurrency: true,
        path: true,
        merchant: { select: { displayName: true } },
      },
    });
    if (!intent?.payerUserId) {
      this.logger.debug(`[sendPaidOutPush] no payer for intentId=${intentId}`);
      return;
    }
    // One notification per payment. On the on-chain rail the payer already
    // got "Paid Rp X" when the settlement verified (`sendSettledPush`); the
    // merchant's fiat payout landing later is our bookkeeping, not news to
    // them. Nanopay has no settled push, so it keeps this one.
    if (intent.path === "takumipay") {
      this.logger.debug(
        `[sendPaidOutPush] skipped for on-chain intentId=${intentId}; payer was notified at settlement`,
      );
      return;
    }
    const transactionId = await this.activityRowId(intentId);
    await this.sendToUser({
      userId: intent.payerUserId,
      title: "Payment Confirmed",
      body: `Your payment to ${intent.merchant.displayName} was received.`,
      source: "payout",
      channelId: "payouts",
      data: {
        intentId,
        ...(transactionId ? { transactionId } : {}),
        merchantDisplayName: intent.merchant.displayName,
        fiatAmountMinor: intent.fiatAmountMinor,
        fiatCurrency: intent.fiatCurrency,
      },
    });
  }

  /**
   * On-chain merchant settlement verified — the payer's one notification
   * for this payment. A spend note in the user's own frame, the way a
   * bank app (myBCA) words it: what YOU spent, where, and what it cost
   * from the balance you paid with:
   *
   *   You spent Rp 48.888
   *   at GTron, SELONG · 2.97 AUSD from your balance
   *
   * Carries `intentId` so the mobile tap handler deep-links to the
   * receipt. The later payout webhook does NOT push again for this rail.
   */
  async sendSettledPush(intentId: string): Promise<void> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: {
        payerUserId: true,
        fiatAmountMinor: true,
        fiatCurrency: true,
        nanopayUsdcAmountMicros: true,
        merchant: { select: { displayName: true } },
        sourceToken: { select: { symbol: true } },
      },
    });
    if (!intent?.payerUserId) {
      this.logger.debug(`[sendSettledPush] no payer for intentId=${intentId}`);
      return;
    }
    const transactionId = await this.activityRowId(intentId);
    const merchant = intent.merchant.displayName;
    const fiat = formatFiatMinor(intent.fiatAmountMinor, intent.fiatCurrency);
    const fromBalance = intent.sourceToken
      ? ` · ${formatTokenMicros(intent.nanopayUsdcAmountMicros ?? 0n)} ${intent.sourceToken.symbol} from your balance`
      : "";
    await this.sendToUser({
      userId: intent.payerUserId,
      title: `You spent ${fiat}`,
      body: `at ${merchant}${fromBalance}`,
      source: "onchain_settlement",
      channelId: "payouts",
      data: {
        intentId,
        // A tapped push is a look-up, not the end of a pay flow: land on
        // the Activity detail (durable record, back → Activity). Older
        // clients without `transactionId` handling still get the receipt.
        ...(transactionId ? { transactionId } : {}),
        merchantDisplayName: merchant,
        fiatAmountMinor: intent.fiatAmountMinor,
        fiatCurrency: intent.fiatCurrency,
      },
    });
  }

  /** The payer's Activity row for this intent, if one has been recorded. */
  private async activityRowId(intentId: string): Promise<string | null> {
    const row = await this.prisma.transactionHistory.findFirst({
      where: { paymentIntentId: intentId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * The only two things a user is ever told about a settlement that did
   * not verify — and neither says "failed" about money they may have
   * spent. `reverted` means the chain itself refused the tx, so nothing
   * moved and saying "you weren't charged" is true. `needs_review` covers
   * everything else (mined-but-mismatched, or still unconfirmed after the
   * full retry budget): the money may have moved, so the message is
   * "we're checking", never "contact support". Neither carries `intentId`
   * on purpose: the receipt screen is for successful payments; these
   * deep-link to the activity detail via `transactionId` instead.
   */
  async sendSettlementIssuePush(
    intentId: string,
    kind: "reverted" | "needs_review",
    transactionId?: string,
  ): Promise<void> {
    const intent = await this.loadIntentForPush(intentId);
    if (!intent) return;
    const merchant = intent.merchant.displayName;
    const copy =
      kind === "reverted"
        ? {
            title: "Payment didn't go through",
            body: `Your payment to ${merchant} didn't go through and you weren't charged. You can try again anytime.`,
          }
        : {
            title: "We're checking your payment",
            body: `Your payment to ${merchant} is being checked. You don't need to do anything, we'll update you once it's done.`,
          };
    await this.sendToUser({
      userId: intent.payerUserId,
      ...copy,
      source: "onchain_settlement",
      channelId: "payouts",
      data: {
        type: "merchant_payment",
        status: kind,
        ...(transactionId ? { transactionId } : {}),
      },
    });
  }

  private async loadIntentForPush(intentId: string): Promise<{
    payerUserId: string;
    fiatAmountMinor: number;
    fiatCurrency: string;
    merchant: { displayName: string };
  } | null> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: {
        payerUserId: true,
        fiatAmountMinor: true,
        fiatCurrency: true,
        merchant: { select: { displayName: true } },
      },
    });
    if (!intent?.payerUserId) {
      this.logger.debug(`[push] no payer for intentId=${intentId}`);
      return null;
    }
    return { ...intent, payerUserId: intent.payerUserId };
  }

  /**
   * The merchant's side of a completed payout: the customer's fiat landed
   * in their bank account. Merchants are Users too (`Merchant.userId`);
   * one without a linked user has nowhere to receive a push.
   */
  async sendMerchantPayoutPush(intentId: string): Promise<void> {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      select: {
        fiatAmountMinor: true,
        fiatCurrency: true,
        merchant: {
          select: { userId: true, displayName: true, payoutChannelCode: true },
        },
      },
    });
    if (!intent?.merchant.userId) {
      this.logger.debug(
        `[sendMerchantPayoutPush] merchant has no user for intentId=${intentId}`,
      );
      return;
    }
    const fiat = formatFiatMinor(intent.fiatAmountMinor, intent.fiatCurrency);
    await this.sendToUser({
      userId: intent.merchant.userId,
      title: `Payout received ${fiat}`,
      body: `A customer payment has landed in your ${intent.merchant.payoutChannelCode} account.`,
      source: "merchant_payout",
      category: NotificationCategory.payments,
      channelId: "payouts",
      dedupeKey: `merchant-payout:${intentId}`,
      data: {
        type: "merchant_payout",
        intentId,
        fiatAmountMinor: intent.fiatAmountMinor,
        fiatCurrency: intent.fiatCurrency,
      },
    });
  }

  /**
   * Outcome of a digital-product purchase (gift card, game voucher). Three
   * shapes, worded from the buyer's side:
   *   - `completed`: the vendor delivered — "your X is ready".
   *   - `payment_failed`: on-chain verification failed, so the vendor was
   *     never called and nothing was delivered. The buyer may or may not
   *     have been charged (a mismatched tx still spent gas), so this says
   *     "we're checking" rather than "you weren't charged".
   *   - `fulfilment_failed`: payment verified but the vendor call failed —
   *     the buyer HAS paid, and this must never read as "try again".
   */
  /**
   * The payment leg could not be verified on-chain. Everything after
   * "paid" — preparing, delivered, delayed, refunded — is
   * `sendFulfilmentPush`, so the buyer is never told "delivered" before
   * the vendor confirms.
   */
  async sendPurchaseOutcomePush(input: {
    walletAddress: string;
    purchaseId: string;
    bookingId: string;
    productName: string;
    outcome: "payment_failed";
  }): Promise<void> {
    await this.sendToWallet({
      walletAddress: input.walletAddress,
      title: "We couldn't verify your payment",
      body: `Your ${input.productName} order is on hold while we check the payment. You don't need to do anything, we'll update you.`,
      source: "purchase",
      category: NotificationCategory.payments,
      channelId: "payouts",
      dedupeKey: `purchase:${input.purchaseId}:${input.outcome}`,
      data: {
        type: "purchase",
        status: input.outcome,
        purchaseId: input.purchaseId,
        bookingId: input.bookingId,
      },
    });
  }

  /**
   * One push per stage of an order's fulfilment leg, for both crypto
   * purchases and points redemptions. `dedupeKey` makes each stage fire at
   * most once per order however many workers observe it. Copy never
   * mentions the vendor — the buyer bought from TakumiPay.
   */
  async sendFulfilmentPush(input: FulfilmentPushInput): Promise<void> {
    const copy = fulfilmentPushCopy(input);
    if (!copy) return;
    const base: SendPushArgs = {
      ...copy,
      source: input.kind === "purchase" ? "purchase" : "redemption",
      category: NotificationCategory.payments,
      channelId: input.kind === "purchase" ? "payouts" : "points",
      dedupeKey: `fulfilment:${input.kind}:${input.id}:${input.stage}`,
      data: {
        type: input.kind,
        status: input.stage,
        ...(input.kind === "purchase"
          ? { purchaseId: input.id }
          : { redemptionId: input.id }),
      },
    };
    if (input.userId) {
      await this.sendToUser({ ...base, userId: input.userId });
    } else if (input.walletAddress) {
      await this.sendToWallet({ ...base, walletAddress: input.walletAddress });
    }
  }

  /**
   * "Your price lock is about to expire" — sent once per booking, ~2
   * minutes before `expiresAt`, and dropped by Expo if it can't land
   * before the booking is gone (a late reminder is worse than none).
   */
  async sendBookingExpiringPush(input: {
    walletAddress: string;
    bookingId: string;
    productName: string;
    expiresAt: Date;
  }): Promise<SendPushResult> {
    const secondsLeft = Math.max(
      30,
      Math.floor((input.expiresAt.getTime() - Date.now()) / 1000),
    );
    const minutes = Math.max(1, Math.round(secondsLeft / 60));
    return this.sendToWallet({
      walletAddress: input.walletAddress,
      title: "Your price lock is about to expire",
      body: `Complete your ${input.productName} purchase in the next ${minutes} minute${minutes === 1 ? "" : "s"} to keep the locked price.`,
      source: "booking_expiring",
      category: NotificationCategory.payments,
      channelId: "payouts",
      dedupeKey: `booking-expiring:${input.bookingId}`,
      ttlSeconds: secondsLeft,
      data: { type: "booking_expiring", bookingId: input.bookingId },
    });
  }

  // ─── inbox ───────────────────────────────────────────────────────────────

  /**
   * The user's notification history, newest first. A user is reached two
   * ways — by id (`sendToUser`) and by wallet (`sendToWallet`) — so both
   * are matched; announcements are matched through the device they were
   * targeted at, since a broadcast row has no per-user owner. Muted and
   * expired rows are not shown: neither was ever a notification the user
   * could have seen.
   */
  async listInbox(input: {
    userId: string;
    walletAddress: string | null;
    cursor?: string;
    take: number;
    unreadOnly?: boolean;
  }): Promise<{
    items: Array<{
      id: string;
      title: string;
      body: string;
      data: unknown;
      category: string | null;
      imageUrl: string | null;
      sentAt: Date;
      readAt: Date | null;
    }>;
    nextCursor: string | null;
  }> {
    const take = Math.min(Math.max(input.take, 1), 100);
    const where = await this.inboxWhere(input.userId, input.walletAddress);
    if (input.unreadOnly) where.readAt = null;

    let cursorFilter: Prisma.NotificationLogWhereInput = {};
    if (input.cursor) {
      const at = await this.prisma.notificationLog.findUnique({
        where: { id: input.cursor },
        select: { sentAt: true },
      });
      if (at) {
        cursorFilter = {
          OR: [
            { sentAt: { lt: at.sentAt } },
            { sentAt: at.sentAt, id: { lt: input.cursor } },
          ],
        };
      }
    }

    const rows = await this.prisma.notificationLog.findMany({
      where: { AND: [where, cursorFilter] },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        title: true,
        body: true,
        data: true,
        category: true,
        imageUrl: true,
        sentAt: true,
        readAt: true,
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async unreadCount(userId: string, walletAddress: string | null) {
    const where = await this.inboxWhere(userId, walletAddress);
    return this.prisma.notificationLog.count({
      where: { ...where, readAt: null },
    });
  }

  /** Mark the given rows — or everything unread — as read. */
  async markRead(
    userId: string,
    walletAddress: string | null,
    ids?: string[],
  ): Promise<number> {
    const where = await this.inboxWhere(userId, walletAddress);
    const result = await this.prisma.notificationLog.updateMany({
      where: {
        ...where,
        readAt: null,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  private async inboxWhere(
    userId: string,
    walletAddress: string | null,
  ): Promise<Prisma.NotificationLogWhereInput> {
    const devices = await this.prisma.devicePushToken.findMany({
      where: { userId },
      select: { id: true },
    });
    const deviceIds = devices.map((d) => d.id);
    const or: Prisma.NotificationLogWhereInput[] = [{ userId }];
    if (walletAddress) {
      or.push({ walletAddress: canonicalizeWalletAddress(walletAddress) });
    }
    if (deviceIds.length > 0) {
      or.push({
        category: NotificationCategory.announcements,
        targetDeviceIds: { hasSome: deviceIds },
      });
    }
    return {
      OR: or,
      deliveryStatus: {
        notIn: [PushDeliveryStatus.muted, PushDeliveryStatus.expired],
      },
    };
  }

  // ─── announcements ───────────────────────────────────────────────────────

  /**
   * Product news to every registered device. Walks signed-in users (their
   * devices + their wallets' subscribed devices, so an anonymous install
   * that holds a signed-in wallet is reached too), honouring each user's
   * `announcements` switch, and never hits one physical device twice even
   * when two users resolve to it. One outbox row per user, so the inbox
   * can show it and delivery is verified like any other push.
   */
  async broadcastAnnouncement(args: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
    imageUrl?: string;
    dedupeKey: string;
  }): Promise<{ users: number; devices: number; muted: number }> {
    const seenDevices = new Set<string>();
    let users = 0;
    let devices = 0;
    let muted = 0;
    // Every signed-in user with at least one device. A few thousand ids in
    // memory is fine; the per-user work below is what dominates.
    const groups = await this.prisma.devicePushToken.groupBy({
      by: ["userId"],
      where: { userId: { not: null } },
    });
    for (const { userId } of groups) {
      if (!userId) continue;
      const resolved = (
        await this.resolveUserDevices(userId, this.prisma)
      ).filter((d) => !seenDevices.has(d.id));
      if (resolved.length === 0) continue;
      const staged = await this.stage(
        resolved,
        {
          ...args,
          source: "announcement",
          category: NotificationCategory.announcements,
          channelId: "announcements",
          dedupeKey: `${args.dedupeKey}:${userId}`,
          data: { type: "announcement", ...(args.data ?? {}) },
        },
        { userId },
        this.prisma,
      );
      if (staged.muted) {
        muted += 1;
        continue;
      }
      if (staged.deduplicated) continue;
      for (const d of resolved) seenDevices.add(d.id);
      users += 1;
      devices += resolved.length;
      await this.enqueue(staged);
    }
    this.logger.log(
      `[announcement] ${args.dedupeKey}: users=${users} devices=${devices} muted=${muted}`,
    );
    return { users, devices, muted };
  }

  // ─── device resolution ───────────────────────────────────────────────────

  /**
   * Every wallet address is its own backend User row with its own JWT
   * (find-or-create by canonical walletAddress — see auth.service.ts). A
   * single physical device only re-POSTs its push token when the wallet
   * *list* changes (see app/_layout.tsx's walletKey effect), not when the
   * user merely switches which wallet is active — so DevicePushToken.userId
   * can be stuck on whichever wallet was active at the last registration,
   * leaving every other wallet's userId with zero directly-matching
   * devices. WalletPushSubscription is populated for every wallet address
   * the device has ever reported (registration POSTs the full wallet list,
   * not just the active one), so fall back to it via this user's own
   * wallet address.
   */
  private async resolveUserDevices(userId: string, db: Db): Promise<Device[]> {
    const [direct, user] = await Promise.all([
      db.devicePushToken.findMany({
        where: { userId },
        select: DEVICE_SELECT,
      }),
      db.user.findUnique({
        where: { id: userId },
        select: { walletAddress: true },
      }),
    ]);
    const viaWallet = user?.walletAddress
      ? await this.subscribedDevices(
          canonicalizeWalletAddress(user.walletAddress),
          db,
        )
      : [];
    return dedupeDevices([...direct, ...viaWallet]);
  }

  /**
   * The mirror image of `resolveUserDevices`: subscriptions are the primary
   * route, but a device that registered while this wallet's own user was
   * signed in (DevicePushToken.userId) held the wallet at that moment — so
   * it is reached even if its subscription row is missing or was clobbered
   * by a racing registration. Without this a transfer TO the wallet is
   * silently dropped while a transfer FROM it (recorded under the same
   * userId) works, which is exactly the asymmetry users notice.
   */
  private async resolveWalletDevices(
    canonicalAddress: string,
    db: Db,
  ): Promise<Device[]> {
    const [subscribed, owner] = await Promise.all([
      this.subscribedDevices(canonicalAddress, db),
      db.user.findUnique({
        where: { walletAddress: canonicalAddress },
        select: { id: true },
      }),
    ]);
    const viaOwner = owner
      ? await db.devicePushToken.findMany({
          where: { userId: owner.id },
          select: DEVICE_SELECT,
        })
      : [];
    return dedupeDevices([...subscribed, ...viaOwner]);
  }

  private async subscribedDevices(
    canonicalAddress: string,
    db: Db,
  ): Promise<Device[]> {
    const subs = await db.walletPushSubscription.findMany({
      where: { walletAddress: canonicalAddress },
      select: { deviceToken: { select: DEVICE_SELECT } },
    });
    return subs.map((s) => s.deviceToken);
  }

  // ─── outbox ──────────────────────────────────────────────────────────────

  /**
   * Write the outbox row. A target that resolves to zero devices is still
   * recorded (`no_device`) — that row is the answer to "I never got the
   * transfer push": nothing was subscribed for the wallet at that moment.
   */
  private async stage(
    devices: Device[],
    args: SendPushArgs,
    target: { userId?: string; walletAddress?: string },
    db: Db,
  ): Promise<SendPushResult> {
    const category = resolveCategory(args);
    const channelId =
      args.channelId ?? (category ? defaultChannelFor(category) : undefined);

    // Muted categories are still recorded (the row answers "why didn't I
    // get X?") but resolve to zero devices and never reach the inbox.
    const muted = !(await this.preferences.isEnabled(target, category, db));
    const deviceIds = muted ? [] : devices.map((d) => d.id);
    const hasDevices = deviceIds.length > 0;
    const expiresAt =
      args.ttlSeconds && args.ttlSeconds > 0
        ? new Date(Date.now() + args.ttlSeconds * 1000)
        : null;

    const data: Prisma.NotificationLogCreateManyInput = {
      userId: target.userId,
      walletAddress: target.walletAddress,
      title: args.title,
      body: args.body,
      data: (args.data ?? {}) as Prisma.InputJsonValue,
      source: args.source ?? "unknown",
      category,
      dedupeKey: args.dedupeKey,
      channelId,
      imageUrl: args.imageUrl,
      recipientCount: deviceIds.length,
      targetDeviceIds: deviceIds,
      pendingDeviceIds: deviceIds,
      expiresAt,
      deliveryStatus: muted
        ? PushDeliveryStatus.muted
        : hasDevices
          ? PushDeliveryStatus.queued
          : PushDeliveryStatus.no_device,
      deliveryCheckedAt: hasDevices ? null : new Date(),
    };

    let logId: string;
    if (args.dedupeKey) {
      // `ON CONFLICT DO NOTHING` rather than create-and-catch: a unique
      // violation inside the caller's open transaction would poison it
      // (Postgres aborts the whole tx), and the caller's own row — the
      // sender's transfer record — must not roll back because the
      // recipient was already notified by another producer.
      const id = randomUUID();
      const inserted = await db.notificationLog.createMany({
        data: [{ ...data, id }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        this.logger.log(
          `[stage] source=${args.source ?? "unknown"} deduplicated (${args.dedupeKey}) for ${describeTarget(target)}`,
        );
        return { attempted: 0, notificationLogId: null, deduplicated: true };
      }
      logId = id;
    } else {
      const log = await db.notificationLog.create({
        data,
        select: { id: true },
      });
      logId = log.id;
    }

    if (muted) {
      this.logger.log(
        `[stage] source=${args.source ?? "unknown"} log=${logId} muted (${category}) for ${describeTarget(target)}`,
      );
      return { attempted: 0, notificationLogId: logId, muted: true };
    }
    if (!hasDevices) {
      this.logger.log(
        `[stage] source=${args.source ?? "unknown"} log=${logId} no devices for ${describeTarget(target)}`,
      );
    }
    return { attempted: deviceIds.length, notificationLogId: logId };
  }

  /**
   * Stage directly to already-resolved devices. For producers that pick
   * their own audience (the announcement broadcast, which walks devices in
   * batches and must not double-hit one device reachable via two users).
   */
  async stageToDevices(
    devices: Device[],
    args: SendPushArgs,
    target: { userId?: string; walletAddress?: string } = {},
    db: Db = this.prisma,
  ): Promise<SendPushResult> {
    return this.stage(devices, args, target, db);
  }

  /** Worker entry point — see `PushDispatchProcessor`. */
  async processDispatch(job: Job<PushDispatchJobData>): Promise<void> {
    const budget = job.opts.attempts ?? 1;
    const final = job.attemptsMade + 1 >= budget;
    const outcome = await this.attemptDelivery(job.data.notificationLogId, {
      final,
    });
    if (outcome === "retry") {
      // Surface to BullMQ so its backoff schedules the next attempt.
      throw new Error(
        `push ${job.data.notificationLogId}: devices still pending after attempt ${job.attemptsMade + 1}/${budget}`,
      );
    }
  }

  /**
   * One delivery attempt for an outbox row. Sends only to the devices still
   * in `pendingDeviceIds`, records what Expo said per device, and reports
   * whether anything is left to retry.
   *
   * Claiming the row (queued → sending) is a compare-and-set, so the BullMQ
   * job, a sweeper re-enqueue and the inline fallback can all race for the
   * same row and exactly one of them sends.
   */
  /**
   * The payload as the device receives it: the row's own `data` plus two
   * routing fields the tap handler needs (mobile `tapRoutes.ts`):
   *   - `notificationId`: the inbox row, so a tap marks it read;
   *   - `targetWallet`: the wallet the push is about. Every wallet is its
   *     own user with its own JWT, so a device holding several wallets has
   *     to switch to this one before it can read the detail.
   * The producer's own keys win on a clash.
   */
  private async deliveredData(log: {
    id: string;
    data: Prisma.JsonValue | null;
    walletAddress: string | null;
    userId: string | null;
  }): Promise<Record<string, unknown>> {
    const own =
      log.data && typeof log.data === "object" && !Array.isArray(log.data)
        ? (log.data as Record<string, unknown>)
        : {};
    let targetWallet = log.walletAddress;
    if (!targetWallet && log.userId) {
      const owner = await this.prisma.user
        .findUnique({
          where: { id: log.userId },
          select: { walletAddress: true },
        })
        .catch(() => null);
      targetWallet = owner?.walletAddress ?? null;
    }
    return {
      notificationId: log.id,
      ...(targetWallet ? { targetWallet } : {}),
      ...own,
    };
  }

  async attemptDelivery(
    notificationLogId: string,
    opts: { final: boolean },
  ): Promise<DeliveryOutcome> {
    const claimed = await this.prisma.notificationLog.updateMany({
      where: {
        id: notificationLogId,
        deliveryStatus: PushDeliveryStatus.queued,
      },
      data: {
        deliveryStatus: PushDeliveryStatus.sending,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      this.logger.debug(
        `[deliver] ${notificationLogId} not claimable (already sent, in flight, or terminal)`,
      );
      return "skipped";
    }

    const log = await this.prisma.notificationLog.findUnique({
      where: { id: notificationLogId },
    });
    if (!log) return "skipped";

    try {
      if (log.expiresAt && log.expiresAt.getTime() <= Date.now()) {
        await this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            deliveryStatus: PushDeliveryStatus.expired,
            pendingDeviceIds: [],
            deliveryCheckedAt: new Date(),
          },
        });
        this.logger.log(
          `[deliver] ${log.id} expired before it could be sent (source=${log.source})`,
        );
        return "done";
      }

      // Fresh tokens for whatever is still pending — a device pruned since
      // staging simply drops out here.
      const devices =
        log.pendingDeviceIds.length === 0
          ? []
          : await this.prisma.devicePushToken.findMany({
              where: { id: { in: log.pendingDeviceIds } },
              select: DEVICE_SELECT,
            });

      if (devices.length === 0) {
        const status =
          log.expoTicketIds.length > 0
            ? PushDeliveryStatus.pending
            : PushDeliveryStatus.unregistered;
        await this.prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            deliveryStatus: status,
            pendingDeviceIds: [],
            ...(status === PushDeliveryStatus.unregistered
              ? { deliveryCheckedAt: new Date() }
              : {}),
          },
        });
        return "done";
      }

      const data = await this.deliveredData(log);
      const messages: ExpoPushMessage[] = devices.map((d) => ({
        to: d.token,
        sound: "default",
        title: log.title,
        body: log.body,
        data,
        channelId: log.channelId ?? undefined,
        priority: "high",
        ...(log.imageUrl ? { richContent: { image: log.imageUrl } } : {}),
        // Let FCM/APNs drop it too, rather than showing a stale push when
        // the device comes back online after the deadline.
        ...(log.expiresAt
          ? { expiration: Math.floor(log.expiresAt.getTime() / 1000) }
          : {}),
      }));

      const okTickets: Omit<PushReceiptEntry, "notificationLogId">[] = [];
      const toPrune: string[] = [];
      const stillPending: string[] = [];
      const errors: string[] = [];

      let offset = 0;
      for (const chunk of this.expo.chunkPushNotifications(messages)) {
        const chunkDevices = devices.slice(offset, offset + chunk.length);
        offset += chunk.length;

        const tickets = await this.sendChunkWithRetry(chunk);
        if (!tickets) {
          // Transport-level failure (network, Expo 5xx): nothing in this
          // chunk reached Expo, so all of it stays pending for the next attempt.
          for (const d of chunkDevices) stillPending.push(d.id);
          errors.push("transport failure");
          continue;
        }

        tickets.forEach((ticket, i) => {
          const device = chunkDevices[i];
          if (!device) return;
          // An "ok" ticket only means Expo accepted the message for
          // delivery — it is not a delivery confirmation. Real delivery
          // errors (stale FCM registration, mismatched sender ID, etc.)
          // only surface later via the receipts endpoint, so we track
          // ticket ids and verify them asynchronously.
          if (ticket.status === "ok") {
            okTickets.push({
              ticketId: ticket.id,
              deviceId: device.id,
              token: device.token,
            });
            return;
          }
          const code = (ticket as { details?: ExpoPushErrorReceipt["details"] })
            .details?.error;
          if (code === "DeviceNotRegistered") {
            toPrune.push(device.id);
            return;
          }
          const reason = `${ticket.message ?? "unknown"} (code=${code ?? "n/a"})`;
          errors.push(reason);
          if (code && RETRYABLE_TICKET_ERRORS.has(code)) {
            stillPending.push(device.id);
            return;
          }
          this.logger.warn(
            `[deliver] ${log.id} device=${device.id} rejected by Expo: ${reason}`,
          );
        });
      }

      const retry = stillPending.length > 0 && !opts.final;
      const everAccepted = okTickets.length > 0 || log.expoTicketIds.length > 0;
      const status: PushDeliveryStatus = retry
        ? PushDeliveryStatus.queued
        : everAccepted
          ? PushDeliveryStatus.pending
          : stillPending.length > 0
            ? PushDeliveryStatus.failed
            : toPrune.length === devices.length
              ? PushDeliveryStatus.unregistered
              : PushDeliveryStatus.undelivered;
      const terminal =
        status === PushDeliveryStatus.failed ||
        status === PushDeliveryStatus.unregistered ||
        status === PushDeliveryStatus.undelivered;

      // If this write fails after Expo accepted tickets, the row is released
      // back to `queued` below and the next attempt re-sends to those
      // devices — a rare duplicate, which for a payment notification is the
      // right side of the trade against a lost one.
      await this.prisma.$transaction(async (tx) => {
        if (toPrune.length > 0) {
          await tx.devicePushToken.deleteMany({
            where: { id: { in: toPrune } },
          });
        }
        await tx.notificationLog.update({
          where: { id: log.id },
          data: {
            deliveryStatus: status,
            pendingDeviceIds: stillPending,
            ...(okTickets.length > 0
              ? { expoTicketIds: { push: okTickets.map((t) => t.ticketId) } }
              : {}),
            ...(errors.length > 0
              ? { lastError: errors.slice(0, 3).join("; ").slice(0, 500) }
              : {}),
            ...(okTickets.length > 0 && !log.dispatchedAt
              ? { dispatchedAt: new Date() }
              : {}),
            ...(terminal ? { deliveryCheckedAt: new Date() } : {}),
          },
        });
        if (okTickets.length > 0) {
          await tx.devicePushToken.updateMany({
            where: { id: { in: okTickets.map((t) => t.deviceId) } },
            data: { lastPushedAt: new Date() },
          });
        }
      });

      if (okTickets.length > 0) {
        const entries: PushReceiptEntry[] = okTickets.map((t) => ({
          ...t,
          notificationLogId: log.id,
        }));
        // Expo recommends waiting at least ~15 minutes before receipts are
        // queryable; 20 minutes gives margin without leaving the token's
        // delivery status unverified for too long.
        await this.receiptQueue
          .add("check-receipts", { entries }, { delay: 20 * 60 * 1000 })
          .catch((err) => {
            this.logger.warn(
              `[deliver] failed to enqueue receipt check for ${log.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      this.logger.log(
        `[deliver] source=${log.source} log=${log.id} attempt=${log.attempts} devices=${devices.length} accepted=${okTickets.length} pruned=${toPrune.length} pending=${stillPending.length} status=${status}`,
      );
      return retry ? "retry" : "done";
    } catch (err) {
      // Unexpected failure mid-attempt (DB down, bug): release the claim so
      // the retry — or the sweeper — can pick the row up again.
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.notificationLog
        .updateMany({
          where: { id: log.id, deliveryStatus: PushDeliveryStatus.sending },
          data: {
            deliveryStatus: opts.final
              ? PushDeliveryStatus.failed
              : PushDeliveryStatus.queued,
            lastError: message.slice(0, 500),
            ...(opts.final ? { deliveryCheckedAt: new Date() } : {}),
          },
        })
        .catch(() => {
          // The sweeper's stuck-`sending` rule covers this.
        });
      throw err;
    }
  }

  /**
   * Safety net for the gaps the queue can't cover on its own. Runs every
   * minute (`PushOutboxSweeper`) on every instance — the worker's CAS makes
   * duplicate re-enqueues harmless. Three shapes of stuck row:
   *
   *   1. `queued`, never attempted, older than 2 min — the process died (or
   *      Redis was unreachable) between committing the row and `queue.add`.
   *   2. `queued` mid-retry, untouched for 15 min — longer than the whole
   *      backoff schedule, so the BullMQ job itself is gone (Redis restart
   *      without persistence, manual queue flush).
   *   3. `sending` for 10 min — a worker claimed it and died before
   *      recording the outcome.
   */
  async sweepOutbox(): Promise<number> {
    const now = Date.now();
    const stuck = await this.prisma.notificationLog.findMany({
      where: {
        OR: [
          {
            deliveryStatus: PushDeliveryStatus.queued,
            attempts: 0,
            sentAt: { lt: new Date(now - SWEEP_NEVER_PICKED_UP_MS) },
          },
          {
            deliveryStatus: PushDeliveryStatus.queued,
            attempts: { gt: 0 },
            updatedAt: { lt: new Date(now - SWEEP_RETRY_ORPHANED_MS) },
          },
          {
            deliveryStatus: PushDeliveryStatus.sending,
            updatedAt: { lt: new Date(now - SWEEP_STUCK_SENDING_MS) },
          },
        ],
      },
      select: { id: true, deliveryStatus: true, attempts: true },
      orderBy: { sentAt: "asc" },
      take: SWEEP_BATCH,
    });
    if (stuck.length === 0) return 0;

    let requeued = 0;
    for (const row of stuck) {
      if (row.deliveryStatus === PushDeliveryStatus.sending) {
        const released = await this.prisma.notificationLog.updateMany({
          where: { id: row.id, deliveryStatus: PushDeliveryStatus.sending },
          data: { deliveryStatus: PushDeliveryStatus.queued },
        });
        if (released.count === 0) continue; // finished in the meantime
      }
      try {
        // A fresh job id per (row, attempt, 5-minute window): the original
        // id may still sit in BullMQ's completed/failed sets, which would
        // otherwise silently de-duplicate the re-enqueue away.
        await this.dispatchQueue.add(
          "dispatch",
          { notificationLogId: row.id },
          {
            jobId: `${row.id}:sweep:${row.attempts}:${Math.floor(now / 300_000)}`,
          },
        );
        requeued += 1;
      } catch (err) {
        this.logger.warn(
          `[sweep] could not re-enqueue ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn(
      `[sweep] re-enqueued ${requeued}/${stuck.length} stuck push notification(s)`,
    );
    return requeued;
  }

  // ─── Expo transport ──────────────────────────────────────────────────────

  /**
   * A thrown error here is a transport-level failure (network blip, Expo
   * 5xx) — distinct from a ticket coming back with an error status, which
   * is a per-message rejection handled by the caller. A few quick inline
   * retries absorb a single flaky request; anything longer is the dispatch
   * worker's job (exponential backoff over minutes). Returns null (not an
   * empty array) after exhausting retries so the caller can tell "nothing
   * sent" apart from "sent, zero accepted".
   */
  private async sendChunkWithRetry(
    chunk: ExpoPushMessage[],
    attempts = 3,
  ): Promise<ExpoPushTicket[] | null> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        const isLast = attempt === attempts;
        const message = err instanceof Error ? err.message : String(err);
        if (isLast) {
          this.logger.error(
            `[dispatch] sendPushNotificationsAsync failed after ${attempts} attempts: ${message}`,
          );
          return null;
        }
        this.logger.warn(
          `[dispatch] sendPushNotificationsAsync failed (attempt ${attempt}/${attempts}): ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    return null;
  }

  /**
   * Verify previously-"ok" tickets against Expo's receipts endpoint. This
   * is where delivery failures actually show up (DeviceNotRegistered from
   * a stale/rotated FCM registration, MismatchSenderId, InvalidCredentials,
   * etc.) — the initial ticket only confirms Expo accepted the request,
   * never that the OS delivered it. Called from `PushReceiptProcessor`
   * on a delay so receipts have had time to populate.
   */
  async checkReceipts(entries: PushReceiptEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const byTicketId = new Map(entries.map((e) => [e.ticketId, e]));
    const ticketIds = entries.map((e) => e.ticketId);
    const chunks = this.expo.chunkPushNotificationReceiptIds(ticketIds);

    const toPruneIds = new Set<string>();
    // A single dispatch can fan out to multiple devices, so aggregate per
    // NotificationLog row: "delivered" wins if any device got it,
    // "unregistered" only if every device came back DeviceNotRegistered
    // (nothing left to retry), otherwise "undelivered".
    type Outcome = "delivered" | "unregistered" | "undelivered";
    const outcomeByLogId = new Map<string, Outcome>();
    const recordOutcome = (logId: string, outcome: Outcome) => {
      const existing = outcomeByLogId.get(logId);
      if (existing === "delivered") return;
      outcomeByLogId.set(
        logId,
        existing === undefined || existing === outcome
          ? outcome
          : "undelivered",
      );
    };

    for (const chunk of chunks) {
      let receipts: Awaited<
        ReturnType<Expo["getPushNotificationReceiptsAsync"]>
      >;
      try {
        receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      } catch (err) {
        this.logger.warn(
          `[checkReceipts] getPushNotificationReceiptsAsync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const [ticketId, receipt] of Object.entries(receipts)) {
        const entry = byTicketId.get(ticketId);
        if (!entry) continue;

        if (receipt.status === "ok") {
          recordOutcome(entry.notificationLogId, "delivered");
          continue;
        }

        const details = (receipt as ExpoPushErrorReceipt).details;
        if (details?.error === "DeviceNotRegistered") {
          toPruneIds.add(entry.deviceId);
          recordOutcome(entry.notificationLogId, "unregistered");
          continue;
        }

        // Surfaces the real reason a push silently never showed up on
        // the device — invisible from the initial "ok" ticket alone.
        this.logger.warn(
          `[checkReceipts] delivery failed for device=${entry.deviceId}: ${receipt.message ?? "unknown"} (code=${details?.error ?? "n/a"})`,
        );
        recordOutcome(entry.notificationLogId, "undelivered");
      }
    }

    if (toPruneIds.size > 0) {
      await this.prisma.devicePushToken
        .deleteMany({ where: { id: { in: [...toPruneIds] } } })
        .catch((err) => {
          this.logger.warn(
            `[checkReceipts] failed to prune stale devices: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      this.logger.log(
        `[checkReceipts] pruned ${toPruneIds.size} unregistered device(s)`,
      );
    }

    await Promise.all(
      [...outcomeByLogId.entries()].map(([logId, status]) =>
        this.prisma.notificationLog
          .updateMany({
            where: {
              id: logId,
              // A row still `queued`/`sending` has devices left to send to
              // — its verdict comes from a later attempt's receipts. And a
              // batch that landed on some devices never downgrades a row
              // another batch already proved delivered.
              deliveryStatus: {
                in:
                  status === "delivered"
                    ? [
                        PushDeliveryStatus.pending,
                        PushDeliveryStatus.undelivered,
                        PushDeliveryStatus.unregistered,
                      ]
                    : [PushDeliveryStatus.pending],
              },
            },
            data: { deliveryStatus: status, deliveryCheckedAt: new Date() },
          })
          .catch((err) => {
            this.logger.warn(
              `[checkReceipts] failed to update NotificationLog ${logId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
      ),
    );
  }
}

function dedupeDevices(devices: Device[]): Device[] {
  return [...new Map(devices.map((d) => [d.id, d])).values()];
}

function describeTarget(target: {
  userId?: string;
  walletAddress?: string;
}): string {
  if (target.userId) return `user=${target.userId}`;
  if (target.walletAddress) return `wallet=${target.walletAddress}`;
  return "explicit tokens";
}
