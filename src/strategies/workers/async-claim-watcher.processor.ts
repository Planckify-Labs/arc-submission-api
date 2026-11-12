/**
 * Async-claim watcher — the pending-claims tracker for two-phase
 * request/claim vaults (docs/defi-evm-protocol-expansion-spec.md §7,
 * requirement 2 — originally ERC-7540-only, widened 2026-08-27 to Solana's
 * Jito Restaking Vault ticket flow, same shape: request now, claim later).
 *
 * An async vault settles as `request → (off-chain fulfil) → claim`. The claim
 * is a SECOND transaction the user has to send, potentially days later, and
 * nothing on-chain will remind them. Without this worker a requested deposit
 * simply stops being visible: funds committed, no position, no prompt. That is
 * the failure mode §7 forbids and the reason the async resolver stays
 * unregistered until this loop is proven.
 *
 * The worker scans positions parked in a `*_requested` phase, reads the
 * vault's own claimable state, and flips them to `*_claimable` once
 * fulfilment lands. The flip is what the app renders as "ready to claim" and
 * what the notification hangs off.
 *
 * Fail-safe in one direction only: an unreadable vault leaves the position
 * pending. We never mark something claimable we could not confirm — a false
 * "ready" shows a claim button that reverts.
 *
 * **Solana branch (`jito-vault-deposit`, mobile's
 * `services/defi/adapters/jitoVaultDeposit.ts`)**: unlike ERC-7540 there is
 * no `claimableRedeemRequest`-style counter — Jito's tickets are individual
 * `VaultStakerWithdrawalTicket` PDAs found via `getProgramAccounts`, and
 * "claimable" is `is_withdrawable`: strictly more than one full epoch has
 * elapsed since `slot_unstaked`. Program id, ticket layout
 * (`dataSize=384`, `staker`@40, `vrtAmount`@104, `slotUnstaked`@112) and
 * `Config`'s `epoch_length`@72 are the SAME constants the mobile adapter
 * already verified live (see that file's header for the full verification
 * story — not re-derived here, only mirrored, since this is a separate
 * repo/runtime that can't import the mobile adapter directly). Only the
 * REDEEM side of this kind is ever async (deposit is a single synchronous
 * `MintTo`, never sets `asyncPhase`), so this branch only needs to answer
 * "is the wallet's outstanding ticket withdrawable yet."
 */

import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Job } from "bullmq";
import { parseAbi } from "viem";
import { PrismaService } from "../../prisma/prisma.service";
import { PushService } from "../../push/push.service";
import { getPublicClientForChain } from "../targets/rpc";
import type { DepositTarget } from "../targets/types";
import { resolveEvmChainId } from "../targets/types";

export const ASYNC_PHASE = {
  depositRequested: "deposit_requested",
  depositClaimable: "deposit_claimable",
  redeemRequested: "redeem_requested",
  redeemClaimable: "redeem_claimable",
} as const;

const ERC7540_VIEW_ABI = parseAbi([
  "function claimableDepositRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
]);

// ── Jito Restaking Vault constants (mirrors
// mobile-app/services/defi/adapters/jitoVaultDeposit.ts exactly — see that
// file's header for the live verification story behind every value here). ──
const JITO_VAULT_PROGRAM_ID = new PublicKey(
  "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8",
);
const [JITO_CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  JITO_VAULT_PROGRAM_ID,
);
const JITO_C_EPOCH_LENGTH = 72; // u64
const JITO_TICKET_SIZE = 384;
const JITO_T_STAKER = 40;
const JITO_T_VRT_AMOUNT = 104; // u64
const JITO_T_SLOT_UNSTAKED = 112; // u64

let solanaConnection: Connection | null = null;
function getSolanaConnection(): Connection {
  if (!solanaConnection) {
    solanaConnection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
  }
  return solanaConnection;
}

@Processor("async-claim-watcher")
export class AsyncClaimWatcherProcessor extends WorkerHost {
  private readonly logger = new Logger(AsyncClaimWatcherProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const pending = await this.prisma.strategyPosition.findMany({
      where: {
        status: "active",
        asyncPhase: {
          in: [ASYNC_PHASE.depositRequested, ASYNC_PHASE.redeemRequested],
        },
      },
      select: {
        id: true,
        walletAddress: true,
        chainId: true,
        chainName: true,
        poolId: true,
        assetSymbol: true,
        protocolSlug: true,
        asyncPhase: true,
        asyncRequestId: true,
        userStrategy: { select: { userId: true } },
      },
    });
    if (pending.length === 0) return;

    let becameClaimable = 0;
    for (const position of pending) {
      try {
        const claimable = await this.readClaimable(position);
        // `null` = could not read. Leave it pending and try again next tick.
        if (claimable === null) continue;
        await this.prisma.strategyPosition.update({
          where: { id: position.id },
          data: {
            asyncCheckedAt: new Date(),
            ...(claimable > 0n
              ? {
                  asyncPhase:
                    position.asyncPhase === ASYNC_PHASE.depositRequested
                      ? ASYNC_PHASE.depositClaimable
                      : ASYNC_PHASE.redeemClaimable,
                }
              : {}),
          },
        });
        if (claimable > 0n) {
          becameClaimable++;
          this.logger.log(
            `[async-claim] position=${position.id} is now claimable (${position.asyncPhase})`,
          );
          // Keyed off the phase flip (§7 requirement 2) rather than every
          // tick, and deduped through the same `StrategyPositionEvent`
          // marker the goal-deadline and auto-compound watchers use — a
          // position sits in a `*_claimable` phase for potentially many
          // scans until the user actually claims, and without the marker
          // every 10-minute tick would re-notify.
          const noun =
            position.asyncPhase === ASYNC_PHASE.depositRequested
              ? "deposit"
              : "withdrawal";
          const eventKind =
            position.asyncPhase === ASYNC_PHASE.depositRequested
              ? "defi.async.deposit_claimable"
              : "defi.async.redeem_claimable";
          const notified = await this.tryRecordEvent(position.id, eventKind);
          if (notified) {
            await this.pushService.sendToUser({
              userId: position.userStrategy.userId,
              title: "Ready to claim",
              body: `Your ${position.assetSymbol} ${noun} on ${position.protocolSlug} has settled — tap to claim it.`,
              data: {
                kind: "async_claimable",
                positionId: position.id,
                protocolSlug: position.protocolSlug,
                chainId: position.chainId,
                // Replayed into the agent on tap (mobile `tapRoutes.ts`),
                // which has the claim tool; the write still needs approval.
                prompt: `Claim my settled ${position.assetSymbol} ${noun} on ${position.protocolSlug}.`,
              },
              channelId: "strategies",
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `[async-claim] position=${position.id} check failed: ${
            (err as Error)?.message ?? err
          } — leaving pending`,
        );
      }
    }

    this.logger.log(
      `[async-claim] scan complete. pending=${pending.length} became_claimable=${becameClaimable}`,
    );
  }

  /**
   * Read the vault's claimable amount for this request, or `null` when we
   * cannot (no target, unreachable chain, revert).
   */
  private async readClaimable(position: {
    walletAddress: string;
    chainName: string;
    poolId: string | null;
    asyncPhase: string | null;
    asyncRequestId: string | null;
  }): Promise<bigint | null> {
    if (!position.poolId) return null;
    const row = await this.prisma.opportunityCache.findUnique({
      where: { poolId: position.poolId },
      select: { depositTarget: true },
    });
    const target = row?.depositTarget as DepositTarget | null;
    if (!target) return null;

    if (target.kind === "jito-vault-deposit") {
      return this.readJitoClaimable(target.vault, position.walletAddress);
    }

    if (target.kind !== "async-vault") return null;

    const chainId = resolveEvmChainId(position.chainName);
    const client = getPublicClientForChain(chainId);
    if (!client) return null;

    const requestId = BigInt(position.asyncRequestId ?? "0");
    const fn =
      position.asyncPhase === ASYNC_PHASE.depositRequested
        ? "claimableDepositRequest"
        : "claimableRedeemRequest";
    try {
      return await client.readContract({
        address: target.vault,
        abi: ERC7540_VIEW_ABI,
        functionName: fn,
        args: [requestId, position.walletAddress as `0x${string}`],
      });
    } catch {
      return null;
    }
  }

  /**
   * Find the wallet's outstanding `VaultStakerWithdrawalTicket` for this
   * vault (there is no counter to read, unlike ERC-7540 — see file header)
   * and report its VRT amount if `is_withdrawable`, else `0n`. `null` only
   * on a genuine read failure (RPC error, ambiguous multi-ticket state) —
   * never on "no ticket yet" or "not withdrawable yet", both of which are
   * legitimate "checked, not ready" answers matching the ERC-7540 branch's
   * own `0n` convention.
   */
  private async readJitoClaimable(
    vault: string,
    staker: string,
  ): Promise<bigint | null> {
    try {
      const connection = getSolanaConnection();
      const vaultPk = new PublicKey(vault);
      const stakerPk = new PublicKey(staker);
      const accounts = await connection.getProgramAccounts(
        JITO_VAULT_PROGRAM_ID,
        {
          filters: [
            { dataSize: JITO_TICKET_SIZE },
            { memcmp: { offset: 8, bytes: vaultPk.toBase58() } },
            { memcmp: { offset: JITO_T_STAKER, bytes: stakerPk.toBase58() } },
          ],
        },
      );
      if (accounts.length === 0) return 0n;
      // Same posture as the mobile adapter's `findOutstandingTicket`: more
      // than one ticket for this (vault, staker) means one was opened
      // outside this app's own `buildRequestRedeem` (which refuses a second
      // enqueue while one is pending) — ambiguous, not "checked, not ready".
      if (accounts.length > 1) return null;

      const data = accounts[0].account.data;
      const vrtAmount = data.readBigUInt64LE(JITO_T_VRT_AMOUNT);
      const slotUnstaked = data.readBigUInt64LE(JITO_T_SLOT_UNSTAKED);

      const configInfo = await connection.getAccountInfo(JITO_CONFIG_PDA);
      if (!configInfo) return null;
      const epochLength = configInfo.data.readBigUInt64LE(
        JITO_C_EPOCH_LENGTH,
      );
      const slot = BigInt(await connection.getSlot("confirmed"));

      const currentEpoch = slot / epochLength;
      const epochUnstaked = slotUnstaked / epochLength;
      const withdrawable = currentEpoch > epochUnstaked + 1n;
      return withdrawable ? vrtAmount : 0n;
    } catch {
      return null;
    }
  }

  /** Same dedup pattern as `auto-compound-watcher.processor.ts`. */
  private async tryRecordEvent(
    positionId: string,
    kind: string,
  ): Promise<boolean> {
    try {
      await this.prisma.strategyPositionEvent.create({
        data: { positionId, kind },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Unique") || message.includes("P2002")) {
        return false;
      }
      throw err;
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`Async claim watcher job ${job.id} completed`);
  }
}
