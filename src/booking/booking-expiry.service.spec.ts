import { Logger } from "@nestjs/common";
import { BookingExpiryService } from "./booking-expiry.service";
import { BookingStatus } from "./enums/booking-status.enum";
import { BookingService } from "./booking.service";

describe("BookingExpiryService", () => {
  it("runs the sweep every minute", () => {
    const cron = Reflect.getMetadata(
      "SCHEDULE_CRON_OPTIONS",
      BookingExpiryService.prototype.sweep,
    );
    expect(cron).toMatchObject({ name: "booking-expiry-sweep" });
  });

  it("calls expireBookings and survives a failure", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const bookings = {
      expireBookings: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("db down")),
    };
    const holds = { releaseStale: jest.fn(async () => 0) };
    const svc = new BookingExpiryService(
      bookings as unknown as BookingService,
      holds as never,
    );
    await svc.sweep();
    await expect(svc.sweep()).resolves.toBeUndefined();
    expect(bookings.expireBookings).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("releases held points only once past expiresAt + grace + 5 min", async () => {
    const holds = { releaseStale: jest.fn(async () => 2) };
    const svc = new BookingExpiryService(
      { expireBookings: jest.fn() } as never,
      holds as never,
    );
    const before = Date.now();
    await svc.sweep();
    const cutoff = (holds.releaseStale.mock.calls[0] as unknown as [Date])[0].getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(120_000 + 5 * 60_000);
    expect(before - cutoff).toBeLessThan(120_000 + 5 * 60_000 + 5_000);
  });

  it("a failing expiry does not stop the hold release", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const holds = { releaseStale: jest.fn(async () => 0) };
    const svc = new BookingExpiryService(
      { expireBookings: jest.fn().mockRejectedValue(new Error("x")) } as never,
      holds as never,
    );
    await svc.sweep();
    expect(holds.releaseStale).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("the sweep it runs skips bookings that have a purchase", async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const svc = new BookingService(
      { bookingOrder: { updateMany } } as never,
      { get: () => 15 } as never,
      {} as never,
      {} as never,
      { invalidateBooking: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await svc.expireBookings();
    const where = (updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe(BookingStatus.PENDING);
    expect(where.purchase).toBeNull();
  });
});
