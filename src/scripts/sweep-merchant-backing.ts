/**
 * CLI script for sweeping merchant-backing funds from the TakumiWallet contract (task 34).
 *
 * Usage:
 *   npx ts-node src/scripts/sweep-merchant-backing.ts \
 *     --chain-id=5042002 \
 *     --token=0x3600000000000000000000000000000000000000 \
 *     --recipient=0x... \
 *     --amount=1000000
 *
 * This calls sweepMerchantBacking(token, recipient, amount) on the contract.
 * Requires ADMIN_WALLET_PRIVATE_KEY in env (the contract owner key).
 *
 * Since contract 2.3.0 the amount is bounded by the token balance minus
 * platformFeeAccrued[token]: the balance backing accrued fees leaves only
 * through sweepPlatformFees. Like every exit it is also bounded by the
 * per-token sweep cap, which no 24h span can exceed; sweepAllowance(token)
 * returns what can leave right now.
 *
 * Pre-flight checks:
 *   1. Verify amount <= token balance - platformFeeAccrued[token], and
 *      amount <= sweepAllowance(token)
 *   2. Verify the caller key matches the contract owner
 *   3. Display a confirmation prompt before executing
 *
 * Environment:
 *   - ADMIN_WALLET_PRIVATE_KEY: 0x-prefixed, 66-char hex private key
 *   - DATABASE_URL: for resolving the "takumi_pay" SmartContract row
 */

export async function main() {
  const args = process.argv.slice(2);
  const params = Object.fromEntries(
    args.map((a) => a.replace("--", "").split("=")),
  );

  const chainId = params["chain-id"];
  const token = params.token;
  const recipient = params.recipient;
  const amount = params.amount;

  if (!chainId || !token || !recipient || !amount) {
    console.error(
      "Usage: npx ts-node src/scripts/sweep-merchant-backing.ts " +
        "--chain-id=<id> --token=<address> --recipient=<address> --amount=<minor-units>",
    );
    process.exit(1);
  }

  console.log("=== Sweep Merchant Backing ===");
  console.log("Chain ID:", chainId);
  console.log("Token:", token);
  console.log("Recipient:", recipient);
  console.log("Amount (minor units):", amount);
  console.log();

  // TODO: Wire up the actual viem writeContract call:
  //
  // import { createWalletClient, http } from "viem";
  // import { privateKeyToAccount } from "viem/accounts";
  // import { TakumiPayAbi } from "../blockchain-verification/abis/takumi-pay.abi";
  //
  // const account = privateKeyToAccount(process.env.ADMIN_WALLET_PRIVATE_KEY as `0x${string}`);
  // const client = createWalletClient({ account, chain, transport: http(rpcUrl) });
  //
  // const hash = await client.writeContract({
  //   address: contractAddress,
  //   abi: TakumiPayAbi,
  //   functionName: "sweepMerchantBacking",
  //   args: [token, recipient, BigInt(amount)],
  // });
  // console.log("Tx hash:", hash);

  console.log(
    "To execute, implement the viem writeContract call with TakumiPayAbi.",
  );
  console.log(
    "This script is a placeholder — wire up the actual contract call before use.",
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
