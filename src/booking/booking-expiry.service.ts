import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingService } from "./booking.service";
import { PointsHoldService } from "../points-hold/points-hold.service";
import {
  BOOKING_PAYMENT_GRACE_MS,
  POINTS_HOLD_RELEASE_DELAY_MS,
} from "./booking.constants";

/**
 * Flips unpaid bookings past `expiresAt` to EXPIRED, every minute.
 *
 * Safe on several instances without a lock: `expireBookings` is one
 * `updateMany` guarded by `status = PENDING AND purchase IS NULL`, so a
 * second instance's run matches nothing, and the cache invalidation after it
 * is idempotent. Bookings that already have a purchase are never touched; a
 * payment is judged against the booking window by chain time when it is
 * processed (see PurchaseProcessor), not by this sweep.
 */
@Injectable()
export class BookingExpiryService {
  private readonly logger = new Logger(BookingExpiryService.name);

  constructor(
    private readonly bookings: BookingService,
    private readonly holds: PointsHoldService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: "booking-expiry-sweep" })
  async sweep(): Promise<void> {
    try {
      await this.bookings.expireBookings();
    } catch (err) {
      this.logger.warn(
        `[booking-expiry] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.releaseStaleHolds();
  }

  /**
   * Points held for a booking nobody paid for go back once the booking is
   * past expiresAt + the payment grace + a few minutes for a late-registered
   * payment. Each release is a compare-and-set from HELD, so several
   * instances (or a payment racing in) release or consume it exactly once.
   */
  private async releaseStaleHolds(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - BOOKING_PAYMENT_GRACE_MS - POINTS_HOLD_RELEASE_DELAY_MS,
      );
      const released = await this.holds.releaseStale(cutoff);
      if (released > 0) {
        this.logger.log(`[booking-expiry] released ${released} point holds`);
      }
    } catch (err) {
      this.logger.warn(
        `[booking-expiry] hold release failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
