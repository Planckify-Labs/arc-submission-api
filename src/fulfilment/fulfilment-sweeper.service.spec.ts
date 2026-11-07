jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { FulfilmentSweeperService } from "./fulfilment-sweeper.service";
import type { FulfilmentService } from "./fulfilment.service";
import type { PrismaService } from "../prisma/prisma.service";

function build(purchases: string[], redemptions: string[] = []) {
  const prisma = {
    purchase: {
      findMany: jest.fn(async () => purchases.map((id) => ({ id }))),
    },
    pointRedemption: {
      findMany: jest.fn(async () => redemptions.map((id) => ({ id }))),
    },
  };
  const fulfilment = { finishStrandedRefund: jest.fn(async () => undefined) };
  const sweeper = new FulfilmentSweeperService(
    prisma as unknown as PrismaService,
    fulfilment as unknown as FulfilmentService,
  );
  return { sweeper, prisma, fulfilment };
}

describe("FulfilmentSweeperService.sweepStrandedRefunds", () => {
  it("retries FAILED orders that have no refund row, of both kinds", async () => {
    const { sweeper, prisma, fulfilment } = build(["p1"], ["r1"]);
    await expect(sweeper.sweepStrandedRefunds()).resolves.toBe(2);
    expect(fulfilment.finishStrandedRefund).toHaveBeenCalledWith("purchase", "p1");
    expect(fulfilment.finishStrandedRefund).toHaveBeenCalledWith("redemption", "r1");
    expect(prisma.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fulfilmentStatus: "FAILED",
          refund: null,
        }),
      }),
    );
  });

  it("keeps going when one refund fails", async () => {
    const { sweeper, fulfilment } = build(["p1", "p2"]);
    fulfilment.finishStrandedRefund.mockRejectedValueOnce(new Error("db"));
    await expect(sweeper.sweepStrandedRefunds()).resolves.toBe(1);
    expect(fulfilment.finishStrandedRefund).toHaveBeenCalledTimes(2);
  });
});
