/**
 * A payment mined up to this long after the booking's `expiresAt` is still
 * honoured (clock skew, a wallet that signed at the last second).
 */
export const BOOKING_PAYMENT_GRACE_MS = 120_000;

/**
 * Extra time, beyond the grace, before the sweep gives held points back for a
 * booking that has no purchase: a payment mined in time can still be
 * registered late through the mobile outbox.
 */
export const POINTS_HOLD_RELEASE_DELAY_MS = 5 * 60_000;
