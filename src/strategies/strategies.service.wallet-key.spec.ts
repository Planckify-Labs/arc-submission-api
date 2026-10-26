import { StrategiesService } from "./strategies.service";

/**
 * `UserStrategy` rows are keyed by the per-encoding canonical address, and
 * rows written before that (blanket-lowercased) must keep resolving without a
 * backfill. A base58 address folded to lowercase is a different string, so a
 * lowercase-only key could never be the right answer for Solana or Stellar.
 */

const EVM_CHECKSUM = "0xc84dEa8032fF10c0cf0a20e0C709299d3E832146";
const SOLANA = "GeCXpkLd9YhXuDpoUFAfPL2p6E6QX1YyJ8uPgfxoRxx1";

function service() {
  const prisma = {
    userStrategy: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => data),
    },
  };
  return {
    prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc: new StrategiesService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ),
  };
}

describe("StrategiesService UserStrategy wallet key", () => {
  it("looks up a Solana wallet by its verbatim address and the legacy fold", async () => {
    const { prisma, svc } = service();
    await svc.getSavedTier(SOLANA);
    expect(prisma.userStrategy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: { in: [SOLANA, SOLANA.toLowerCase()] } },
      }),
    );
  });

  it("looks up an EVM wallet by checksum and the legacy fold, whatever case arrives", async () => {
    const { prisma, svc } = service();
    await svc.getSavedTier(EVM_CHECKSUM.toLowerCase());
    expect(prisma.userStrategy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          walletAddress: { in: [EVM_CHECKSUM, EVM_CHECKSUM.toLowerCase()] },
        },
      }),
    );
  });

  it("writes new rows canonical, not lowercased", async () => {
    const { prisma, svc } = service();
    await svc.ensureUserStrategy("user-1", SOLANA, "solana", "balanced");
    expect(prisma.userStrategy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ walletAddress: SOLANA }),
      }),
    );
  });
});
