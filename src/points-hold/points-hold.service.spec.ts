import { ConflictException, Logger } from "@nestjs/common";
import { PointsHoldService } from "./points-hold.service";

type Booking = {
  id: string;
  pointsApplied: bigint;
  pointsHoldStatus: "NONE" | "HELD" | "CONSUMED" | "RELEASED";
  pointTransactionId: string | null;
  pointTransactionCreatedAt: Date | null;
  expiresAt: Date;
  purchase: { id: string } | null;
};

/** In-memory stand-in with the same atomic semantics the service relies on. */
function buildFake(opts: { balance?: bigint } = {}) {
  const balances = new Map<string, bigint>([["u1", opts.balance ?? 100n]]);
  const ledger: Array<Record<string, unknown>> = [];
  const bookings = new Map<string, Booking>();
  let seq = 0;

  const tx = {
    pointBalance: {
      updateMany: jest.fn(
        async ({ where, data }: { where: { userId: string; balance: { gte: bigint } }; data: { balance: { decrement: bigint } } }) => {
          const cur = balances.get(where.userId) ?? 0n;
          if (cur < where.balance.gte) return { count: 0 };
          balances.set(where.userId, cur - data.balance.decrement);
          return { count: 1 };
        },
      ),
      upsert: jest.fn(
        async ({ where, create, update }: { where: { userId: string }; create: { balance: bigint }; update: { balance: { increment: bigint } } }) => {
          const cur = balances.get(where.userId);
          balances.set(
            where.userId,
            cur === undefined ? create.balance : cur + update.balance.increment,
          );
        },
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { userId: string } }) => ({
        balance: balances.get(where.userId) ?? 0n,
      })),
      findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => ({
        balance: balances.get(where.userId) ?? 0n,
      })),
    },
    pointTransaction: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `ptx_${++seq}`, createdAt: new Date(1_000 + seq) };
        ledger.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id_createdAt: { id: string } } }) =>
        ledger.find((r) => r.id === where.id_createdAt.id) ?? null,
      ),
    },
    bookingOrder: {
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; pointsHoldStatus: string }; data: { pointsHoldStatus: Booking["pointsHoldStatus"] } }) => {
          const b = bookings.get(where.id);
          if (!b || b.pointsHoldStatus !== where.pointsHoldStatus) return { count: 0 };
          b.pointsHoldStatus = data.pointsHoldStatus;
          return { count: 1 };
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Booking> }) => {
        Object.assign(bookings.get(where.id)!, data);
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => bookings.get(where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => bookings.get(where.id)!),
      findMany: jest.fn(async ({ where, take }: { where: { pointsHoldStatus: string; purchase: null; expiresAt: { lt: Date } }; take: number }) =>
        [...bookings.values()]
          .filter(
            (b) =>
              b.pointsHoldStatus === where.pointsHoldStatus &&
              b.purchase === null &&
              b.expiresAt < where.expiresAt.lt,
          )
          .slice(0, take)
          .map((b) => ({ id: b.id })),
      ),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const cache = { invalidateBalance: jest.fn(async () => undefined) };
  const svc = new PointsHoldService(prisma as never, cache as never);

  const addBooking = (id: string, over: Partial<Booking> = {}) => {
    bookings.set(id, {
      id,
      pointsApplied: 0n,
      pointsHoldStatus: "NONE",
      pointTransactionId: null,
      pointTransactionCreatedAt: null,
      expiresAt: new Date(0),
      purchase: null,
      ...over,
    });
  };
  /** A booking with a real hold, made the way createBooking makes it. */
  const heldBooking = async (id: string, points: bigint, over: Partial<Booking> = {}) => {
    addBooking(id, { pointsApplied: points, pointsHoldStatus: "HELD", ...over });
    await svc.holdInTx(tx as never, { userId: "u1", bookingId: id, points });
  };
  return { svc, prisma, tx, balances, ledger, bookings, cache, heldBooking, addBooking };
}

describe("PointsHoldService.holdInTx", () => {
  it("takes the points atomically and ledgers a SPEND that references the booking", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("b1", 30n);
    expect(f.balances.get("u1")).toBe(70n);
    expect(f.ledger[0]).toMatchObject({
      type: "SPEND",
      amount: -30n,
      balanceBefore: 100n,
      balanceAfter: 70n,
      referenceType: "BOOKING",
      referenceId: "b1",
    });
    expect(f.bookings.get("b1")?.pointTransactionId).toBe("ptx_1");
  });

  it("two concurrent bookings cannot spend the same points", async () => {
    const f = buildFake({ balance: 100n });
    f.addBooking("b1", { pointsApplied: 80n, pointsHoldStatus: "HELD" });
    f.addBooking("b2", { pointsApplied: 80n, pointsHoldStatus: "HELD" });
    const results = await Promise.allSettled([
      f.svc.holdInTx(f.tx as never, { userId: "u1", bookingId: "b1", points: 80n }),
      f.svc.holdInTx(f.tx as never, { userId: "u1", bookingId: "b2", points: 80n }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    expect(f.balances.get("u1")).toBe(20n);
    expect(f.ledger).toHaveLength(1);
  });

  it("never lets the balance go negative", async () => {
    const f = buildFake({ balance: 10n });
    f.addBooking("b1", { pointsApplied: 11n, pointsHoldStatus: "HELD" });
    await expect(
      f.svc.holdInTx(f.tx as never, { userId: "u1", bookingId: "b1", points: 11n }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.balances.get("u1")).toBe(10n);
  });
});

describe("PointsHoldService.release / consume", () => {
  it("release credits and ledgers a REFUND once; a second release is a no-op", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("b1", 30n);

    expect(await f.svc.release("b1", "expired")).toBe(true);
    expect(f.balances.get("u1")).toBe(100n);
    expect(f.ledger[1]).toMatchObject({
      type: "REFUND",
      amount: 30n,
      referenceId: "b1",
    });
    expect(f.cache.invalidateBalance).toHaveBeenCalledWith("u1");

    expect(await f.svc.release("b1", "expired")).toBe(false);
    expect(f.balances.get("u1")).toBe(100n);
    expect(f.ledger).toHaveLength(2);
  });

  it("two simultaneous releases credit once", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("b1", 30n);
    const [a, b] = await Promise.all([
      f.svc.release("b1", "x"),
      f.svc.release("b1", "y"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(f.balances.get("u1")).toBe(100n);
  });

  it("a bookings with no hold releases nothing", async () => {
    const f = buildFake();
    f.addBooking("b0");
    expect(await f.svc.release("b0", "x")).toBe(false);
    expect(f.ledger).toHaveLength(0);
  });

  it("consume wins -> a later release does nothing; points stay spent", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("b1", 30n);
    expect(await f.svc.consume("b1")).toBe("CONSUMED");
    expect(await f.svc.release("b1", "sweep")).toBe(false);
    expect(f.balances.get("u1")).toBe(70n);
  });

  it("release wins -> consume reports RELEASED", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("b1", 30n);
    await f.svc.release("b1", "sweep");
    expect(await f.svc.consume("b1")).toBe("RELEASED");
  });

  it("consume is repeatable (a retried job) and NONE for a booking without points", async () => {
    const f = buildFake();
    await f.heldBooking("b1", 30n);
    expect(await f.svc.consume("b1")).toBe("CONSUMED");
    expect(await f.svc.consume("b1")).toBe("CONSUMED");
    f.addBooking("b0");
    expect(await f.svc.consume("b0")).toBe("NONE");
  });
});

describe("PointsHoldService.releaseStale", () => {
  it("releases unpaid holds past the cutoff once, skipping bookings with a purchase", async () => {
    const f = buildFake({ balance: 100n });
    await f.heldBooking("old", 10n);
    await f.heldBooking("paid", 10n, { purchase: { id: "pur_1" } });
    await f.heldBooking("fresh", 10n, { expiresAt: new Date(Date.now() + 60_000) });

    const cutoff = new Date();
    expect(await f.svc.releaseStale(cutoff)).toBe(1);
    expect(f.bookings.get("old")?.pointsHoldStatus).toBe("RELEASED");
    expect(f.bookings.get("paid")?.pointsHoldStatus).toBe("HELD");
    expect(f.bookings.get("fresh")?.pointsHoldStatus).toBe("HELD");

    // Running the sweep again (another instance) releases nothing more.
    expect(await f.svc.releaseStale(cutoff)).toBe(0);
    expect(f.balances.get("u1")).toBe(80n);
  });

  it("one failing release does not stop the rest", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const f = buildFake({ balance: 100n });
    // Broken: HELD but no ledger pointer, so release throws (and rolls back).
    f.addBooking("broken", { pointsApplied: 5n, pointsHoldStatus: "HELD" });
    await f.heldBooking("good", 10n);
    f.bookings.get("broken")!.expiresAt = new Date(0);

    expect(await f.svc.releaseStale(new Date())).toBe(1);
    expect(f.bookings.get("good")?.pointsHoldStatus).toBe("RELEASED");
    warn.mockRestore();
  });
});
