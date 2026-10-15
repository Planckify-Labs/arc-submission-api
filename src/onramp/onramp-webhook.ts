/**
 * Onramp webhook: verification seam + tolerant normalizer.
 *
 * Spec: mobile-app docs/onramp-app-kit-spec.md §5.4, open question Q2.
 *
 * The Arc docs say "reconcile from webhooks" and stop: no event names, no
 * payload, no signature scheme. We deliberately do NOT borrow the scheme of
 * another Circle product (the spec forbids guessing). So:
 *
 *   - Verification is a seam. Until Q2 is answered the bound verifier is
 *     `UnconfiguredOnrampWebhookVerifier`, which rejects everything, and the
 *     endpoint answers 503. Nothing unauthenticated can move an order.
 *   - The normalizer only understands the vocabulary the widget itself
 *     documents (`DEPOSIT_SUBMITTED` / `DEPOSIT_SETTLED` /
 *     `DEPOSIT_NOT_COMPLETED`, `orderId`, `transactionHash`, `sessionId`).
 *     Anything else normalizes to `null` and is acknowledged and ignored.
 *
 * When Q2 lands: implement `OnrampWebhookVerifier`, bind it in
 * `onramp.module.ts`, and extend `normalizeOnrampWebhook` if the real
 * payload differs. The order/push pipeline behind it is already done.
 */

export const ONRAMP_WEBHOOK_VERIFIER = Symbol("ONRAMP_WEBHOOK_VERIFIER");

export type OnrampWebhookVerdict =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "invalid_signature" };

export interface OnrampWebhookVerifier {
  verify(input: {
    rawBody: Buffer | undefined;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<OnrampWebhookVerdict>;
}

export class UnconfiguredOnrampWebhookVerifier
  implements OnrampWebhookVerifier
{
  async verify(): Promise<OnrampWebhookVerdict> {
    return { ok: false, reason: "not_configured" };
  }
}

export type OnrampOrderTransition = "submitted" | "settled" | "failed";

export interface NormalizedOnrampUpdate {
  /** Dedup key for at-least-once delivery. Null = cannot dedup, still idempotent. */
  notificationId: string | null;
  sessionId: string | null;
  orderId: string | null;
  transition: OnrampOrderTransition;
  txHash: string | null;
  amount: string | null;
  token: string | null;
  /** Our closed code on `failed`, from the widget's documented codes. */
  failureCode: string | null;
}

const KNOWN_FAILURE_CODES = new Set([
  "SESSION_TIMEOUT",
  "CANCELED_BY_CUSTOMER",
  "NO_PAYMENT_OPTIONS",
  "CUSTOMER_PENDING_REVIEW",
  "CUSTOMER_REJECTED",
  "PAYMENT_PROVIDER_ERROR",
]);

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pull an order update out of an unknown body, or null when the body does
 * not speak the documented vocabulary. Accepts the envelope at the root or
 * under `notification` / `data` (both common Circle wrappers), but never
 * invents a transition from an unknown event name.
 */
export function normalizeOnrampWebhook(
  body: unknown,
): NormalizedOnrampUpdate | null {
  const root = record(body);
  if (!root) return null;
  const inner = record(root.notification) ?? record(root.data) ?? root;
  const payload = record(inner.payload) ?? inner;

  const event = str(inner.event) ?? str(root.event);
  const transition: OnrampOrderTransition | null =
    event === "DEPOSIT_SUBMITTED"
      ? "submitted"
      : event === "DEPOSIT_SETTLED"
        ? "settled"
        : event === "DEPOSIT_NOT_COMPLETED"
          ? "failed"
          : null;
  if (!transition) return null;

  const sessionId = str(payload.sessionId) ?? str(inner.sessionId);
  const orderId = str(payload.orderId) ?? str(inner.orderId);
  if (!sessionId && !orderId) return null;

  const txHash = str(payload.transactionHash, 100);
  const code = str(inner.code) ?? str(root.code);
  const rawAmount = payload.amount;
  const amount =
    typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? String(rawAmount)
      : typeof rawAmount === "string" && /^\d+(\.\d+)?$/.test(rawAmount)
        ? rawAmount
        : null;
  const token = str(payload.tokenSymbol, 12);

  return {
    notificationId: str(root.notificationId) ?? str(root.id),
    sessionId,
    orderId,
    transition,
    txHash: txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : null,
    amount,
    token: token && /^[A-Za-z0-9]+$/.test(token) ? token.toUpperCase() : null,
    failureCode:
      transition === "failed" && code && KNOWN_FAILURE_CODES.has(code)
        ? code
        : transition === "failed"
          ? "UNKNOWN"
          : null,
  };
}
