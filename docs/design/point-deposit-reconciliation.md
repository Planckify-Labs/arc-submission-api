# Point Deposit Reconciliation — finding deposits that were paid on-chain but never credited

**Status:** Future work. Not built. Nothing in this doc is implemented.
**Found during:** the point-deposit idempotency fix, 2026-10-23, which followed the Arc Studio security review of `TakumiPay.sol` 2.1.0.
**Related:** `src/points/points.service.ts` (`createDeposit`), `src/points/processors/point-deposit.processor.ts`, `src/points/point-deposit-identity.ts`, `mobile-app/services/points/pointDepositOutbox.ts`, `contract/evm/src/TakumiPay.sol` (`depositPoints`, `PointDepositCreated`).

## 1. The gap

Points are credited only after the app calls `POST /points/deposit`. That call happens **after** the on-chain `depositPoints` has already moved the user's money. The API has no on-chain listener for point deposits. A deposit it never hears about stays in the contract, uncredited, and nothing on our side knows it exists.

The 2026-10-23 fix narrowed this gap a lot:

| Failure | Before | After |
|---|---|---|
| POST fails (offline, 5xx, expired session) | Lost; the UI said "Deposit failed", so the user paid again | Kept in the mobile outbox and retried with the same refId for 30 days |
| API rejects after the user paid (no exchange rate, token switched off) | refId left claimed with no row; every retry dead-ended | Validation runs before any write; retries succeed once the cause is fixed |
| Another user submits the refId first | Victim blocked, or credited to the attacker via a self-asserted wallet link | Only the session wallet can claim its own deposit; other users' rows don't block it |

What still loses a deposit:

- **The app is killed between the chain returning the tx hash and the MMKV write.** The window is microseconds, but it exists. The outbox can't be written earlier, because the hash doesn't exist until the tx is broadcast.
- **The outbox never drains.** The paying wallet never becomes active and signed in again within 30 days, or the app is uninstalled.
- **Deposits lost before 2026-10-23.** These went through the old dead ends and won't recover on their own.
- **Any client that isn't the mobile app** (a script, a third-party wallet calling the contract directly).

Reconciliation closes all of these by treating the chain, not the app's POST, as the source of truth.

## 2. Source of truth: the `PointDepositCreated` event (EVM)

```solidity
event PointDepositCreated(
    uint256 indexed depositId,
    address indexed walletAddress,
    address indexed tokenAddress,
    string refId,
    uint256 amount,
    uint256 timestamp
);
```

Events are the right source, rather than walking `pointDeposits(1..pointDepositCounter())`, because each log carries the **txHash** and block number. A deposit row needs the txHash: the EVM verifier (`verifyPointDeposit`) waits on that tx's receipt. The struct read has no hash.

`pointDepositCounter()` still has a job: `depositId` is sequential, so a gap between the ids seen in logs and the counter means the scan missed something.

## 3. Proposed design

A per-contract scanner, run as a BullMQ repeatable job.

1. **Scan.** `eth_getLogs` for `PointDepositCreated` on each active TakumiPay `SmartContract`, from a saved cursor (initially the contract's deploy block) up to `head − minConfirmations`. Use `Blockchain.minConfirmations`, through the same `resolveMinConfirmations` the worker uses. Page the range: providers cap `eth_getLogs` (often around 10k blocks), and Arc produces blocks quickly.
2. **Persist the cursor** per contract, only after the page is processed.
3. **Check completeness.** Compare the highest `depositId` seen against `pointDepositCounter()`, and alert on gaps.
4. **Match** each event to `PointTransaction` rows by (blockchainId, contract, refId). Use `samePointDeposit` from `src/points/point-deposit-identity.ts`, the same identity intake and the worker use.
5. **Classify.**
   - **Credited:** a `COMPLETED` row exists. Done.
   - **In flight:** a `PENDING`/`CONFIRMED` row exists, possibly `needsReview`. Leave it to the worker or ops.
   - **Missing:** no row. Go to step 6.
6. **Recover a missing deposit.** Find the `User` whose `walletAddress` equals the event's `walletAddress`. This is safe to automate. Since 2026-10-23 the only account that may claim a deposit is the one signed in as that exact wallet, and the payer is proven by the chain, so the credit can't be redirected. Create the `PENDING` row (refId, txHash, token, amount, payer) under `lockPointDeposit`, then enqueue it with `pointDepositJobId`. The normal worker then verifies and credits it. The worker's credit-once guard makes a race with a late app POST harmless.

**Rollout:** run steps 1–5 as a **read-only report** first, against Arc mainnet and the other live EVM contracts. That shows whether anything was actually lost before automatic recovery is switched on.

## 4. Other chains

- **Stellar:** contract events are available, but Soroban RPC keeps them only for about 7 days. Deposits older than that must come from walking the deposit counter with `get_point_deposit`, and the txHash is then unavailable from the record alone.
- **Solana:** reading the program's point-deposit record accounts is more reliable than parsing transaction logs. Verification is already PDA-based and doesn't need the signature.

## 5. Open questions

1. **Which point rate applies to a recovered deposit?** A lost deposit never had a `pointRate` stored. Options: the rate at the deposit's on-chain `timestamp` (fairer, but needs historical exchange rates), or the rate at recovery time (simpler, but moves with the market). This is a product decision.
2. **A payer with no account.** If the paying wallet never signed in, there is no `User` to credit. Keep it in the report until that wallet signs in, or create the user on the spot?
3. **Pre-2026-10-23 deposits found by the report.** Credit them automatically, or hand each one to ops? Some may already be in `needsReview` under another user's row, created via the old wallet-link path.
4. **Cadence.** Every few minutes as a safety net, or only as a daily report? The mobile outbox already handles the common case quickly.
