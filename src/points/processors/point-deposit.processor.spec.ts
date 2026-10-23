// PushService pulls in the ESM-only expo-server-sdk, which jest cannot load.
jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { Prisma } from "@generated/prisma";
import type { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import type { BlockchainVerificationService } from "../../blockchain-verification/blockchain-verification.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PushService } from "../../push/push.service";
import type { PointsCacheService } from "../../valkey/services/points-cache.service";
import { PointDepositProcessor } from "./point-deposit.processor";

const createdAt = new Date("2026-10-23T00:00:00Z");

function buildHarness(opts: { alreadyCredited?: { id: string } | null } = {}) {
  const pointTx = {
    id: "ptx_1",
    createdAt,
    userId: "u1",
    status: "PENDING",
    refId: "pt_1",
    txHash: "0xhash",
    contractAddress: "0xCONTRACT",
    walletAddress: "0xUSER",
    tokenAmount: new Prisma.Decimal("1000000"),
    pointRate: new Prisma.Decimal("16000"),
    metadata: null,
    user: { id: "u1", walletAddress: "0xUSER" },
    token: { contractAddress: "0xTOKEN", decimals: 6, symbol: "USDC" },
    blockchain: { id: "bc_1", type: "EVM", chainId: 5042, minConfirmations: 1 },
  };

  const tx = {
    $executeRaw: jest.fn(async () => 1),
    pointTransaction: {
      findFirst: jest.fn(async () => opts.alreadyCredited ?? null),
      update: jest.fn(async () => ({})),
    },
    pointBalance: {
      findUnique: jest.fn(async () => ({ balance: BigInt(5) })),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    pointTransaction: {
      findUnique: jest.fn(async () => pointTx),
      update: jest.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  const verification = {
    verifyPointDeposit: jest.fn(async () => ({})),
  } as unknown as BlockchainVerificationService;
  const pointsCache = {
    invalidateBalance: jest.fn(async () => undefined),
  } as unknown as PointsCacheService;
  const push = {
    sendToUser: jest.fn(async () => undefined),
  } as unknown as PushService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;

  const processor = new PointDepositProcessor(
    prisma,
    verification,
    pointsCache,
    push,
    config,
  );
  const job = {
    id: "job_1",
    attemptsMade: 0,
    data: { pointTransactionId: "ptx_1", pointTransactionCreatedAt: createdAt },
  } as unknown as Job<{
    pointTransactionId: string;
    pointTransactionCreatedAt: Date;
  }>;

  return { processor, job, tx, push, pointsCache };
}

describe("PointDepositProcessor crediting", () => {
  it("credits a verified deposit under the deposit lock", async () => {
    const { processor, job, tx, push } = buildHarness();
    await processor.process(job);

    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.pointTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          refId: "pt_1",
          blockchainId: "bc_1",
          status: "COMPLETED",
          NOT: { id: "ptx_1" },
        }),
      }),
    );
    // 1 USDC at 16000 points/USDC on top of the existing 5.
    expect(tx.pointBalance.update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { balance: BigInt(16005) },
    });
    expect(tx.pointTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(push.sendToUser).toHaveBeenCalled();
  });

  it("never credits an on-chain deposit a second time", async () => {
    const { processor, job, tx, push, pointsCache } = buildHarness({
      alreadyCredited: { id: "ptx_other" },
    });
    await processor.process(job);

    expect(tx.pointBalance.update).not.toHaveBeenCalled();
    expect(tx.pointBalance.create).not.toHaveBeenCalled();
    expect(tx.pointTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          metadata: expect.objectContaining({ duplicateOf: "ptx_other" }),
        }),
      }),
    );
    expect(pointsCache.invalidateBalance).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
  });
});
