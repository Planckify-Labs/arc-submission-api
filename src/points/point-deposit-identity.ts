import { PointTransactionType, Prisma } from "@generated/prisma";

/**
 * What names one on-chain point deposit. The contract makes `refId` unique
 * per contract, so (chain, contract, refId) is exactly one deposit — the
 * txHash is not part of it (the EVM verifier only checks that hash's
 * receipt succeeded; the record itself is read by refId).
 */
export interface PointDepositIdentity {
  blockchainId: string;
  contractAddress: string;
  refId: string;
}

/**
 * Rows recorded against the same on-chain deposit, for any user.
 * `PointTransaction` is a TimescaleDB hypertable, so there is no unique
 * index to lean on — callers pair this with `lockPointDeposit`.
 */
export function samePointDeposit(
  d: PointDepositIdentity,
): Prisma.PointTransactionWhereInput {
  return {
    type: PointTransactionType.DEPOSIT,
    blockchainId: d.blockchainId,
    refId: d.refId,
    contractAddress: { equals: d.contractAddress, mode: "insensitive" },
  };
}

/**
 * Serializes every transaction touching the same on-chain deposit until the
 * calling transaction commits. Stands in for the unique index the hypertable
 * cannot have: intake uses it so a double-submit can't create two rows, and
 * the worker uses it so a deposit can't be credited twice.
 *
 * `$executeRaw` rather than `$queryRaw`: the lock function returns `void`,
 * which Prisma cannot deserialize as a result column.
 */
export async function lockPointDeposit(
  tx: Prisma.TransactionClient,
  d: PointDepositIdentity,
): Promise<void> {
  const key = `point-deposit:${d.blockchainId}:${d.contractAddress.toLowerCase()}:${d.refId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** BullMQ job id for a deposit's verification. Custom ids may not contain ':'. */
export function pointDepositJobId(pointTransactionId: string): string {
  return `point-deposit-${pointTransactionId}`;
}
