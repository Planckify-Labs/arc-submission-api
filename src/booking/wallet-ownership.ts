import { BadRequestException } from "@nestjs/common";
import { addressesEqual } from "../auth/address-compare";

/**
 * A booking is paid for from `walletAddress`, and `POST /purchases` only
 * accepts the signed-in session wallet as payer. Enforcing the same rule when
 * the booking is made means a mismatch surfaces BEFORE the buyer pays, not
 * after the money has moved. Deliberately the session wallet only: the
 * `WalletAccountLink` rows are self-asserted (POST /auth/google/wallets takes
 * no proof), so honouring them would let anyone claim a stranger's address.
 */
export function assertCallerOwnsWallet(
  user: { walletAddress?: string | null } | undefined,
  walletAddress: string | undefined,
): void {
  if (!addressesEqual(user?.walletAddress, walletAddress)) {
    throw new BadRequestException(
      "Wallet address does not belong to the authenticated user",
    );
  }
}
