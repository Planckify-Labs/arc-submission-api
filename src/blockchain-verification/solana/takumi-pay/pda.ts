import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const TAKUMI_PAY_PROGRAM_ID = new PublicKey(
  "Baj91uzqwt8hRaJmke3dV8RdBwjq5MaWEtKNuUFTBBwS",
);

function bnToLeBytes(value: BN, byteLength: number): Buffer {
  return value.toArrayLike(Buffer, "le", byteLength);
}

export function deriveConfigPda(
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );
}

export function deriveTxRecordPda(
  programId: PublicKey,
  config: PublicKey,
  txId: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tx"), config.toBuffer(), bnToLeBytes(txId, 8)],
    programId,
  );
}

export function deriveRefRecordPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ref"), config.toBuffer(), Buffer.from(refIdHash)],
    programId,
  );
}

export function deriveMerchantPaymentPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("merchant_payment"),
      config.toBuffer(),
      Buffer.from(refIdHash),
    ],
    programId,
  );
}

export function derivePlatformFeePda(
  programId: PublicKey,
  config: PublicKey,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("platform_fee"),
      config.toBuffer(),
      tokenMint.toBuffer(),
    ],
    programId,
  );
}

export function derivePointDepositPda(
  programId: PublicKey,
  config: PublicKey,
  depositId: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("point_deposit"),
      config.toBuffer(),
      bnToLeBytes(depositId, 8),
    ],
    programId,
  );
}

export function derivePointRefRecordPda(
  programId: PublicKey,
  config: PublicKey,
  refIdHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("point_ref"),
      config.toBuffer(),
      Buffer.from(refIdHash),
    ],
    programId,
  );
}
