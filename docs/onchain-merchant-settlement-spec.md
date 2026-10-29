# Engineering Spec: Onchain Settlement Rail for Merchant Payments

**Status:** Draft (rev 4 — resolves two §11 open questions: explicit on-chain platform fee, per-chain confirmation tuning table)
**Author:** Satria Ali
**Date:** 2026-04-24
**Related:** `umkm-usdc-payout-spec.md §6.2/§6.4`, commit `d9703da` (provider-agnostic payout), tasks 29/30/43

---

## Vocabulary

- **Quote** = a price snapshot the backend guarantees for a short window. The customer is told "for IDR 100,000, send 6.35 USDC, valid until T". `PaymentIntent` is the row that stores the quote — `QUOTED` status means "waiting for payment against a locked rate".
- **Booking** (in this doc) = synonymous with quote; we use "quote" because the existing code does (`fxQuotedAt`, `QUOTED`).
- **Settlement** = the act of proving on-chain (or via Circle) that the customer paid. Distinct from **payout** (sending IDR to the merchant via Xendit/Duitku).
- **Custody** = the contract holds the customer's tokens until ops off-ramps them. Merchant never sees tokens — they only ever receive IDR.

---

## 1. Goal

Allow merchant (UMKM) payment intents to settle through the **existing, battle-tested TakumiWallet onchain verification pipeline** as an alternative to the (untested) **Circle Nanopay / x402 facilitator** rail. Rail selection must be a one-line flip (`ENV`) or per-intent (`PaymentIntent.path`), and adding a third rail later must not touch any caller — same "space-docking" (ports-and-adapters) discipline we already use for `PayoutProvider`.

IDR disbursement (Xendit / Duitku) is **unchanged** — it receives a `SETTLED` intent and fires, agnostic to how settlement happened.

Solana parity for the onchain rail is **out of scope** (separate session).

---

## 2. Current-State Analysis

### 2.1 The battle-tested user-purchase verification (reference implementation)

**Entry**: `PurchaseProcessor.verifyBlockchainTransaction` in `src/queue/processors/purchase.processor.ts:353-389` dispatches to:

**Core**: `BlockchainVerificationService.verifyTransaction` in `src/blockchain-verification/blockchain-verification.service.ts:167-283`.

Two-phase check:

**Phase A — tx-level (lines 185-247):**
1. `client.waitForTransactionReceipt({ hash, confirmations: minimumConfirmations, timeout: 60_000 })` — this is the 12-block gate. `minimumConfirmations` defaults to `this.minConfirmations`, sourced from `MIN_CONFIRMATIONS` env via `getBlockchainConfig()` (`.env.example:22`, `CLAUDE.md`), callers can override per-call.
2. `receipt.status === "success"` — reverted → fail.
3. `transaction.chainId === expectedChainId` — wrong chain → fail.
4. `transaction.from == expectedSender` (lowercased) — spoof guard.
5. `transaction.to == expectedRecipient` (contract address) — routing guard.
6. Re-read confirmations via `getBlockNumber() - receipt.blockNumber + 1` as a belt-and-braces check (line 225).

**Phase B — contract-level (`verifyTransactionInContract`, lines 341-455):**
Calls `readContract({ abi: TakumiWalletAbi, functionName: "getTransactionByRef", args: [refId] })`. The struct returned (`takumi-wallet.abi.ts:561-613`) is:

```
struct Transaction {
  address walletAddress;      // payer
  address tokenAddress;       // ERC-20 paid in (or native sentinel)
  string  bookingId;
  uint256 exchangeRateId;
  string  productVariantId;
  uint256 timestamp;
  string  refId;              // contract's echo of the arg
  uint256 amount;
}
```

Compared against DB expectations:
- `refId` equal (line 368).
- `walletAddress` equal via `addressesEqual` (line 376).
- `tokenAddress` equal, with native-token fast path (line 386).
- `amount.toString() === expectedAmount` (line 402) — **string-compare of a bigint**, precision-safe.
- `bookingId`, `exchangeRateId`, `productVariantId` equal if present.

### 2.2 What this verifier proves — and does NOT prove

**Proves:** (a) a finalized on-chain transfer exists with (b) the expected sender paying (c) the expected token (d) the expected amount (e) to our contract, AND (f) our contract's persisted bookkeeping for that `refId` matches what the backend expected at booking time. Replay safety is "refId was consumed on-chain exactly once and the contract's idempotent write matches our DB snapshot."

**Does NOT prove:**
- That the `to` address in the receipt is the contract we intended (no cross-check vs DB-configured `contractAddress` at phase A — phase B implicitly checks by calling it). If `expectedRecipient` is wrong the tx-level check fails first, so this is fine in practice; worth being explicit in review.
- That the contract method emitted no counterfeit data (we trust the contract source — this is in-scope for the Solidity review).
- Anti-reorg beyond 12 confirmations. For USDC on Arc / L2s, 12 blocks is currently adequate per §6.2; for any chain with probabilistic finality < 12-block depth we may need chain-specific overrides (already supported via `minimumConfirmations` arg).

### 2.3 Merchant settlement rail today (Nanopay / x402)

Path: Mobile signs EIP-3009 → `POST /v1/pay/intents/:id/nanopay` → `IntentsService.submitNanopay` → proxies to Circle Gateway's `/gateway/v1/x402/settle` → Circle attests → intent flipped to `SETTLED` → `kickPayout(intentId)` fires `PayoutService.trigger` asynchronously → Xendit / Duitku disbursement.

Key files:
- `src/pay/intents.service.ts:750-886` — EVM nanopay.
- `src/pay/intents.service.ts:912-1046` — SVM nanopay.
- `src/pay/intents.service.ts:1740-1760` — `kickPayout` (fire-and-forget).

Persistence: `NanopaySubmission` row (`prisma/schema.prisma:914-927`) stores the signature + Circle's tx UUID.

Intent statuses (`prisma/schema.prisma:787-794`): `QUOTED → SIGNED → SETTLED → PAID_OUT | FAILED | EXPIRED`. Path enum (`prisma/schema.prisma:796-800`): `nanopay | x402 | direct_arc` — note `direct_arc` already exists as an intended future rail but is unused; we will claim it.

### 2.4 "Space docking" pattern in this codebase

Language note: the project calls ports-and-adapters the "space-docking port" (see `payout-provider.port.ts:4-11`). The canonical example is the payout refactor in commit `d9703da`:

- **Port**: `IPayoutProviderAdapter` (`src/payout/payout-provider.port.ts:26-66`).
- **Adapters**: `XenditPayoutProvider`, `DuitkuPayoutProvider` (under `src/payout/providers/`).
- **Factory**: `PayoutService.resolveProvider(key)` at `src/payout/payout.service.ts:169-178` — the **only** place in the codebase that branches on provider id, per the port's explicit rule.
- **Selection**: per-merchant — `Merchant.payoutProvider` column (`prisma/schema.prisma:851`).
- **Registration**: `PayoutModule` binds Symbol tokens (`PAYOUT_PROVIDER_XENDIT`, `PAYOUT_PROVIDER_DUITKU`) and injects both adapters (`payout.module.ts:36-57`).

Adding a provider is: new adapter file → new Symbol token → new case arm in `resolveProvider` + constructor `@Inject` — no caller changes. This is the exact contract the new rail must honor.

---

## 3. Problem Statement

1. Nanopay is untested in production; shipping merchants on it blind is a risk.
2. Onchain verification (12-block + `getTransactionByRef`) is fully tested on the user-purchase side and will handle arbitrary EVM chains we onboard.
3. We need a second rail where the customer pays by **sending a real on-chain transfer to the TakumiWallet contract** (same as the purchase flow), and the merchant still gets IDR disbursed via Xendit/Duitku.
4. Rail selection must be runtime-controllable without code changes.

---

## 4. Proposed Design

### 4.1 New port: `IPaymentSettlementProvider` (rail-level space-docking)

A second ports-and-adapters axis — settlement (how we prove the customer paid) — parallel to but distinct from payout (how we send IDR). Two adapters at launch:

| Adapter | Proves payment via | DB mark |
|---|---|---|
| `NanopaySettlementProvider` | Circle x402 facilitator 200 OK | `path = nanopay` |
| `OnchainSettlementProvider` | `BlockchainVerificationService.verifyTransaction` | `path = direct_arc` |

**Port** (new file `src/pay/settlement/settlement-provider.port.ts`):

```ts
export interface IPaymentSettlementProvider {
  /**
   * Key the factory matches against (`PAYMENT_SETTLEMENT_RAIL` env or
   * `PaymentIntent.path`).
   */
  readonly key: "nanopay" | "onchain";

  /**
   * Settle a single intent. Throws `SettlementRejectedError` on terminal
   * fail (maps to intent.FAILED), `SettlementInFlightError` on timeout
   * (maps to intent.SIGNED / "SETTLING" on the wire).
   */
  settle(args: SettleArgs): Promise<SettleReceipt>;
}

export const PAYMENT_SETTLEMENT_NANOPAY = Symbol("PAYMENT_SETTLEMENT_NANOPAY");
export const PAYMENT_SETTLEMENT_ONCHAIN = Symbol("PAYMENT_SETTLEMENT_ONCHAIN");
```

`SettleArgs` carries `{ intent, merchant, payerInput }` where `payerInput` is a discriminated union of `{ kind: "signature"; signature }` (nanopay) or `{ kind: "txHash"; txHash; chainId }` (onchain). Adapters ignore the arm they don't own.

### 4.2 Factory + selection precedence

Resolution order (highest precedence first):

1. **Per-intent**: `PaymentIntent.path` if it's a concrete settlement key (`nanopay` | `direct_arc`). Already persisted at intent-create time, so a single intent's rail is pinned.
2. **Env default**: `PAYMENT_SETTLEMENT_RAIL` (new) — `"nanopay"` (default) or `"onchain"`. Used when the intent was created before the column was populated, or when the user's new-intent request does not specify a rail.
3. **Merchant preference** (future): `Merchant.preferredSettlementRail` column — deferred; not in v1.

Factory lives in a new `SettlementOrchestratorService` (sibling of `PayoutService`) with a single `resolveProvider(key)` switch — identical shape to `PayoutService.resolveProvider`. No caller branches on `path`.

### 4.3 Wire-level API shape

Add one endpoint, keep the existing one untouched:

| Rail | Endpoint | Body |
|---|---|---|
| Nanopay (existing) | `POST /v1/pay/intents/:id/nanopay` | `{ signature }` |
| Nanopay SVM (existing) | `POST /v1/pay/intents/:id/nanopay-svm` | `{ signedTransaction }` |
| **Onchain (new)** | `POST /v1/pay/intents/:id/onchain` | `{ txHash, chainId }` |

Rationale: keep the rail visible in the URL so mobile can dispatch on `nanopay.kind` (already does) and so logs / Swagger are self-describing. Unified endpoint was considered and rejected — the body shapes are materially different, and forcing a discriminated union on the wire costs more than it saves.

Response shape reuses the existing `NanopaySubmitResponseDto` (rail-agnostic — mobile's polling code is already blind to the rail). Rename to `SettlementSubmitResponseDto` in a follow-up (out of scope to avoid a big rename in this task).

### 4.4 Onchain adapter

`src/pay/settlement/providers/onchain.settlement.provider.ts` (new). Reuses `BlockchainVerificationService` for the 12-block + contract-state check, then extends it with a **merchant-payment-shaped** verification call (see §4.7).

```ts
@Injectable()
export class OnchainSettlementProvider implements IPaymentSettlementProvider {
  readonly key = "onchain";
  constructor(
    private readonly blockchainVerification: BlockchainVerificationService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async settle({ intent, payerInput }: SettleArgs): Promise<SettleReceipt> {
    if (payerInput.kind !== "txHash") {
      throw new SettlementRejectedError("PAYER_INPUT_WRONG_KIND", ...);
    }
    const { txHash, chainId } = payerInput;

    // Idempotency: (intentId, txHash) — replay returns the prior row.
    const existing = await this.prisma.onchainSettlement.findFirst({
      where: { intentId: intent.id, txHash },
    });
    if (existing) return this.projectReceipt(existing);

    // Rail-specific resolution. Contract address + signer come off the
    // Blockchain row (per-chain config), NOT off the client.
    const chainRow = await this.prisma.blockchain.findFirstOrThrow({
      where: { chainId, isActive: true, isEVM: true },
    });
    const payer = await this.prisma.user.findUniqueOrThrow({
      where: { id: intent.payerUserId! },
    });

    // Phase A — generic tx-level checks (12 confirmations, sender, recipient).
    // Reuses the proven verifyTransaction tx-level branch only — we skip its
    // built-in Phase B because it calls getTransactionByRef (purchase shape).
    // See §4.7 for the merchant-shaped contract verification we run instead.
    await this.blockchainVerification.verifyTxReceiptOnly({
      transactionHash: txHash,
      expectedSender: payer.walletAddress,
      expectedRecipient: chainRow.takumiWalletContract,
      expectedChainId: chainId,
      minimumConfirmations: this.minConfirmations(chainRow),
    });

    // Phase B — merchant-payment-shaped contract verification.
    await this.blockchainVerification.verifyMerchantPaymentInContract({
      contractAddress: chainRow.takumiWalletContract,
      chainId,
      refId: intent.id, // refId = intent.id — §4.5
      expectedPayer: payer.walletAddress,
      expectedMerchantId: intent.merchantId,
      expectedTokenAddress: intent.sourceTokenAddress,
      expectedAmount: intent.tokenAmountMinor.toString(),
      expectedFiatAmountMinor: intent.fiatAmountMinor,
      expectedFiatCurrency: intent.fiatCurrency,
      expectedExchangeRateId: intent.exchangeRateId,
    });

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.onchainSettlement.create({
        data: { intentId: intent.id, txHash, chainId, verifiedAt: new Date() },
      });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "SETTLED" },
      });
      return created;
    });
    return this.projectReceipt(row);
  }

  /** Per-chain confirmation override; falls back to global env. */
  private minConfirmations(chain: { minConfirmations?: number | null }): number {
    return chain.minConfirmations
      ?? this.configService.get<number>("ONCHAIN_MIN_CONFIRMATIONS")
      ?? this.configService.get<number>("MIN_CONFIRMATIONS", 12);
  }
}
```

After `settle(...)` returns, the orchestrator calls `kickPayout(intent.id)` exactly as `submitNanopay` does today — this is the single code path that must fire `PayoutService.trigger` regardless of rail.

**Refactor note:** `BlockchainVerificationService.verifyTransaction` today bundles Phase A (tx-level) + Phase B (`getTransactionByRef`) in one method (lines 167-283). This spec splits it into two callable surfaces — `verifyTxReceiptOnly` and `verifyMerchantPaymentInContract` — so the merchant rail can compose the parts it needs. The existing `verifyTransaction` becomes a thin wrapper preserving backward-compatibility for `PurchaseProcessor`.

### 4.5 refId = intentId

We reuse `PaymentIntent.id` (ULID) as the on-chain `refId`. Reasons:
- The ULID is already server-signed + idempotent per `(Idempotency-Key, body-hash)` (`intents.service.ts:141-142`).
- It's lexicographically time-ordered — friendly for the contract's event log.
- Existing purchase flow uses `refId` too, so the ABI is unchanged.

Mobile wallet must be updated to pass `intent.id` into the contract call's `refId` argument when constructing the onchain tx. This is a breaking change for any existing onchain-merchant call sites — there are none in production today, so this is free.

### 4.6 Why a dedicated `MerchantPayment` struct (not reuse)

The existing contract `Transaction` struct carries `bookingId`, `productVariantId` — product-purchase fields with no merchant-payment meaning. Three options were considered:

- **Option A — Reuse** with empty `bookingId`/`productVariantId`. Saves zero meaningful gas, costs semantic clarity, pollutes events.
- **Option B — Dedicated `MerchantPayment` struct + method + event.** Clean separation, queryable events per domain. **Selected.**
- **Option C — Generalize the existing struct.** Breaks on-chain backward compat for the deployed purchase flow. Rejected.

Option A is acceptable as a *short* prototype window if the Solidity PR slips Phase 4 — the adapter's call site is isolated so the swap is one method. Plan to ship Option B from day 1.

### 4.7 Extending the TakumiWallet contract — merchant payment + signed-quote design

**This section specifies additions to the existing deployed `TakumiWallet` contract** (`src/blockchain-verification/abis/takumi-wallet.abi.ts`). The contract currently handles user-purchase custody via `payForProduct` / `getTransactionByRef` using the `Transaction` struct (§2.1, §4.6). We extend it — **not replace** — with a parallel merchant-payment domain: new struct, new storage mapping, new functions, new events. Existing purchase functionality is untouched; both domains share the same contract address and owner.

**Existing contract state preserved (no migration):**
- `Transaction` struct + `getTransactionByRef` + `getTransactionsByAddress` — purchase flow continues to use these as-is. `PurchaseProcessor` and `BlockchainVerificationService.verifyTransactionInContract` are not modified.
- Constructor, ownership model, token whitelists (if any) — unchanged.
- Deployed address per chain — unchanged. The extension is additive; no redeployment unless the chain's proxy pattern requires it.

**What's new** (all additive):
- `QuoteCommitment` struct — the quote the backend signs (EIP-712).
- `MerchantPayment` struct — the on-chain settlement record.
- `processMerchantPayment(QuoteCommitment, backendSignature)` — entry point for merchant payments.
- `getMerchantPaymentByRef(refId)` — read function for backend verification.
- `backendSigner` state + `rotateBackendSigner` — EIP-712 signer management.
- `platformFeeAccrued` mapping + `sweepPlatformFees` + `sweepMerchantBacking` — treasury accounting.
- `MerchantPaymentProcessed` + `PlatformFeesSwept` + `BackendSignerRotated` events.

**ABI update:** after deployment, a new ABI file `takumi-wallet-merchant.abi.ts` (or append to the existing `takumi-wallet.abi.ts`) exposes the new functions to viem's `readContract` / `writeContract`. The adapter (§4.4) imports the merchant-payment subset.

---

**Quote authenticity problem:** without authentication, a customer can call `processMerchantPayment` with arbitrary refIds and amounts — funds end up stuck in the contract under refIds the backend has never heard of. No theft vector, but a griefing + storage-bloat one.

**Solution: backend signs each quote with EIP-712; contract verifies before accepting.** Mirrors how the nanopay rail already works (Circle signs the EIP-3009 authorization) — same trust model, our signer instead of Circle's.

```solidity
// types
struct QuoteCommitment {
    string  refId;              // = PaymentIntent.id (ULID)
    string  merchantId;         // = Merchant.id (ULID)
    address tokenAddress;       // address(0) = native; ERC-20 contract otherwise
    uint256 amount;             // TOTAL token minor units customer pays
    uint256 platformFeeAmount;  // portion of `amount` that is platform revenue
                                // (backend computes; must satisfy ≤ amount)
    uint256 fiatAmountMinor;    // IDR owed to merchant (does NOT include platform fee)
    bytes3  fiatCurrency;       // "IDR" today
    uint256 exchangeRateId;     // backend FX snapshot id
    uint256 expiresAt;          // UNIX seconds — quote validity window
}

struct MerchantPayment {
    address payer;              // msg.sender at processing time
    address tokenAddress;
    string  merchantId;
    string  refId;
    uint256 amount;             // total custodied by the contract for this payment
    uint256 platformFeeAmount;  // labeled portion that is platform revenue
    uint256 fiatAmountMinor;    // IDR owed to merchant
    bytes3  fiatCurrency;
    uint256 exchangeRateId;
    uint256 timestamp;          // block.timestamp
}

// state
address public backendSigner;                     // settable by owner; rotates on key rollover
mapping(bytes32 => bool) private _consumedRefs;   // anti-replay; key = keccak256(refId)
mapping(bytes32 => MerchantPayment) private _payments;
// Cumulative platform-fee bookkeeping per token. Incremented by
// platformFeeAmount on every successful processMerchantPayment, decremented
// by sweepPlatformFees. Enables treasury to withdraw only what has accrued
// without touching merchant-backing funds.
mapping(address => uint256) public platformFeeAccrued;

event MerchantPaymentProcessed(
    string  indexed refId,
    string  indexed merchantId,
    address indexed payer,
    address tokenAddress,
    uint256 amount,
    uint256 platformFeeAmount,
    uint256 fiatAmountMinor,
    uint256 exchangeRateId
);

event PlatformFeesSwept(address indexed token, address indexed recipient, uint256 amount);
event BackendSignerRotated(address indexed previous, address indexed next);

// EIP-712 typehash (computed once at deploy / immutable)
bytes32 public constant QUOTE_TYPEHASH = keccak256(
    "QuoteCommitment(string refId,string merchantId,address tokenAddress,"
    "uint256 amount,uint256 platformFeeAmount,uint256 fiatAmountMinor,"
    "bytes3 fiatCurrency,uint256 exchangeRateId,uint256 expiresAt)"
);

function processMerchantPayment(
    QuoteCommitment calldata quote,
    bytes           calldata backendSignature
) external payable {
    // 1. Quote must not be expired (hard reject — see §4.9).
    require(block.timestamp <= quote.expiresAt, "QUOTE_EXPIRED");

    // 2. Anti-replay — refId is single-use across the contract's lifetime.
    bytes32 refKey = keccak256(bytes(quote.refId));
    require(!_consumedRefs[refKey], "REF_CONSUMED");

    // 3. Backend signature — proves backend issued this quote.
    bytes32 digest = _hashTypedDataV4(_hashQuote(quote));
    require(ECDSA.recover(digest, backendSignature) == backendSigner, "BAD_QUOTE");

    // 4. Fee sanity — platform fee must not exceed total. Defense-in-depth
    //    against a backend bug or malicious key that signs an inconsistent
    //    split. Cheap check (one SLOAD-free comparison).
    require(quote.platformFeeAmount <= quote.amount, "FEE_EXCEEDS_AMOUNT");

    // 5. Custody — pull tokens, branching on native vs. ERC-20.
    if (quote.tokenAddress == address(0)) {
        require(msg.value == quote.amount, "NATIVE_AMOUNT_MISMATCH");
    } else {
        require(msg.value == 0, "UNEXPECTED_NATIVE");
        IERC20(quote.tokenAddress).safeTransferFrom(msg.sender, address(this), quote.amount);
    }

    // 6. Persist + commit + accrue fee.
    _consumedRefs[refKey] = true;
    _payments[refKey] = MerchantPayment({
        payer:             msg.sender,
        tokenAddress:      quote.tokenAddress,
        merchantId:        quote.merchantId,
        refId:             quote.refId,
        amount:            quote.amount,
        platformFeeAmount: quote.platformFeeAmount,
        fiatAmountMinor:   quote.fiatAmountMinor,
        fiatCurrency:      quote.fiatCurrency,
        exchangeRateId:    quote.exchangeRateId,
        timestamp:         block.timestamp
    });
    platformFeeAccrued[quote.tokenAddress] += quote.platformFeeAmount;

    emit MerchantPaymentProcessed(
        quote.refId,
        quote.merchantId,
        msg.sender,
        quote.tokenAddress,
        quote.amount,
        quote.platformFeeAmount,
        quote.fiatAmountMinor,
        quote.exchangeRateId
    );
}

/**
 * Treasury-only: withdraw accrued platform fees for a given token. Bounded by
 * the cumulative `platformFeeAccrued` counter so this can NEVER dip into
 * merchant-backing custody. Merchant-backing sweeps use the separate
 * `sweepMerchantBacking` below.
 */
function sweepPlatformFees(address token, address recipient, uint256 amount)
    external onlyOwner
{
    require(amount > 0 && amount <= platformFeeAccrued[token], "FEE_AMOUNT_INVALID");
    platformFeeAccrued[token] -= amount;
    _transferOut(token, recipient, amount);
    emit PlatformFeesSwept(token, recipient, amount);
}

/**
 * Treasury-only: withdraw merchant-backing funds to the off-ramp wallet.
 * The contract does NOT prevent this from dipping into fee-accrual territory
 * as a safety valve (treasury is ultimately owner-authoritative), but the
 * accrued-fee counter stays monotonic so audit reports show clean separation
 * as long as ops respects the invariant off-chain.
 */
function sweepMerchantBacking(address token, address recipient, uint256 amount)
    external onlyOwner
{
    _transferOut(token, recipient, amount);
    // Deliberately no accrued-fee mutation here — that's sweepPlatformFees's job.
}

function getMerchantPaymentByRef(string calldata refId)
    external view returns (MerchantPayment memory)
{
    return _payments[keccak256(bytes(refId))];
}

function rotateBackendSigner(address next) external onlyOwner {
    emit BackendSignerRotated(backendSigner, next);
    backendSigner = next;
}
```

> **Superseded by contract 2.3.0.** `sweepMerchantBacking` can no longer dip into fee-accrual territory: it is bounded by `balance - platformFeeAccrued[token]`. The whole-treasury exits (`withdraw`, `withdrawAll`, `executeWithdrawal`, `recoverToken`) still can. When one does, the contract lowers `platformFeeAccrued` to the balance left and emits `PlatformFeesSwept` for the fees it took. Every capped exit also shares one per-token limit: no 24h span can see more than `sweepCap[token]` leave. See `contract/evm/docs/olympix-bugpocer-response-2.2.0.md` (5.2.2, 5.2.5).

**On-chain invariants enforced:**
1. Quote is signed by the current `backendSigner` (else `BAD_QUOTE`).
2. Quote has not expired (else `QUOTE_EXPIRED`).
3. `refId` is single-use (else `REF_CONSUMED`).
4. `platformFeeAmount <= amount` (else `FEE_EXCEEDS_AMOUNT`).
5. ERC-20 path: `transferFrom` succeeds (else revert from token contract).
6. Native path: `msg.value == amount` (else `NATIVE_AMOUNT_MISMATCH`).
7. `sweepPlatformFees` bounded by `platformFeeAccrued[token]` (else `FEE_AMOUNT_INVALID`).
8. Event emitted before return — backend indexer has a durable hook.

**What is NOT passed (and why):**
- `payer` — `msg.sender` is authoritative; passing it would let the caller lie.
- `chainId` — implicit in the chain the tx executes on.
- Merchant payout details (bank account / QRIS PAN) — off-chain PII, never on-chain.
- `productVariantId` / `bookingId` — purchase-flow residue.
- Platform fee — if/when added, computed inside the function from a governance-set constant, never accepted as an arg.

**Backend-side signing** lives in a new `QuoteSignerService` (`src/pay/quote-signer.service.ts`). On `POST /v1/pay/intents`, after the intent row is persisted, the service computes the EIP-712 digest and signs with `QUOTE_SIGNER_PRIVATE_KEY` (or falls back to `ADMIN_WALLET_PRIVATE_KEY` for v1). The signature is returned in the response body alongside the intent so mobile can pass both into the contract call:

```ts
// PaymentIntentResponseDto adds:
quoteSignature: `0x${string}`;   // EIP-712 signature over the QuoteCommitment
quoteCommitment: {                // The exact struct the contract expects
  refId, merchantId, tokenAddress, amount,
  fiatAmountMinor, fiatCurrency, exchangeRateId, expiresAt
};
```

Mobile passes `quoteCommitment + quoteSignature` straight into `processMerchantPayment`. No wallet-side signing required (the customer signs the EVM tx itself, paying gas — that's a separate wallet signature).

Solana parity is **out of scope for this spec**. The signed-quote pattern translates (Anchor program reads an Ed25519 signature over the same logical struct), but the wire format and signing primitives differ.

#### 4.7a Platform fee math (backend-computed, on-chain labeled)

Decision (resolves §11 open question): **the platform fee is an explicit, labeled portion of the on-chain `amount`, computed by backend at quote time and recorded in the `MerchantPayment` struct + event.** Rate is governance-set per-token and per-chain, stored off-chain in DB (`Token.platformFeeBps` — §5.4), so it can change per-quote (promos, merchant tiers) without contract redeploys.

**Why labeled-on-chain, not DB-only:** backend could track fees purely off-chain from the spread between `amount` paid and `fiatAmountMinor` disbursed. But that conflates two revenue streams (FX markup + platform fee) and makes the fee opaque to any external auditor reading the chain. On-chain labeling keeps platform revenue independently verifiable.

**Why labeled (not split to a separate address):** splitting at pay time would require a second `transferFrom` call per payment (+~21k gas) and would leak the fee-collection address to every counterparty. Labeling + sweep keeps the customer's tx cheap and centralizes treasury exposure.

**Quote-time math** (`IntentsService.createIntent`):

```ts
const token       = await resolveToken(dto.sourceTokenId);
const rate        = await getLatestFxRate(token.symbol, "IDR"); // per-token
const platformBps = token.platformFeeBps; // 0..1000, governance-set

// merchant_backing_tokens ≡ fiatAmountMinor converted at locked rate+markup
const merchantBacking = mulDiv(dto.fiatAmountMinor, 10n ** BigInt(token.decimals),
                                rate.scaledRate) * (10_000n + rate.markupBps) / 10_000n;

// Customer pays merchant_backing + fee. Fee is a bps slice of customer-paid total,
// so solve: total = merchantBacking / (1 - platformBps/10_000).
const totalAmount       = merchantBacking * 10_000n / BigInt(10_000 - platformBps);
const platformFeeAmount = totalAmount - merchantBacking;

// Persist on PaymentIntent (§5.3):
//   tokenAmountMinor  = totalAmount
//   platformFeeAmount = platformFeeAmount
// Sign as part of QuoteCommitment (§4.7) — contract verifies `platformFeeAmount <= amount`.
```

**Invariants (enforced at three layers):**
1. Backend: `platformFeeAmount + merchantBacking === totalAmount` (unit test).
2. Contract: `platformFeeAmount <= amount` (revert `FEE_EXCEEDS_AMOUNT`).
3. Treasury reconcile: `Σ MerchantPayment.platformFeeAmount per token == platformFeeAccrued[token] + Σ PlatformFeesSwept(amount)` (ops dashboard query). Still exact in contract 2.3.0: when a withdrawal takes fee-backed balance, the contract lowers `platformFeeAccrued` and emits `PlatformFeesSwept` for the same amount.

**Zero-fee case** (`platformFeeBps = 0` or merchant-tier override): `platformFeeAmount = 0`, struct field still present, event still fires. No special-casing — keeps the code path uniform.

**Fee-capture independence of off-ramp:** the contract doesn't know what IDR the tokens will off-ramp to. Platform revenue is captured deterministically at pay time (`platformFeeAmount` tokens in the contract), not at off-ramp time. Off-ramp volatility affects what merchant-backing tokens become in IDR terms (spread/slippage), not the platform fee.

### 4.8 Token flexibility — Option C (per-intent token selection)

**Customer-side concern only** — merchant remains token-blind end-to-end (`Merchant` model carries no token fields, payout always speaks IDR). The flexibility lives in the customer's wallet picker.

**Scope today:** stablecoins only (USDC, USDT). **Forward-compat:** native tokens (ETH, MATIC, …) and IDR-pegged stablecoins (IDRX) without schema migration.

**DTO change:**

```ts
// src/pay/dto/create-intent.dto.ts
CreateIntentDto {
  merchantId: string;
  fiatAmountMinor: number;
  fiatCurrency: "IDR";              // already there
  sourceTokenId: string;            // NEW — Token.id (ULID) from mobile picker
  sourceChainId: number;            // already there (rename from usdcSourceChainId
                                    // in a follow-up cleanup PR)
}
```

**Schema additions** (no migration needed — column exists or is trivially added):

- `Token.isPaymentEnabled Boolean @default(false)` — ops gate distinct from `isActive`. Lets us list a token in mobile balances/transfers without yet accepting it for merchant payment. Required to whitelist USDC/USDT for v1 and add IDRX/native later via a single SQL flip.
- `PaymentIntent.sourceTokenId String` (NEW FK to `Token.id`).
- `PaymentIntent.tokenAmountMinor BigInt` (rename from `usdcAmountMicros` — keep the column for one release as a Prisma `@map`-aliased read-only alias if needed).
- `PaymentIntent.fxFromCurrency` already exists — populated from `token.symbol` at quote time instead of hardcoded `"USDC"`.

**Quote-math widening:** `IntentsService.createIntent` resolves the FX rate as:

```ts
const rate = await this.exchangeRateService.getLatest({
  fromCurrency: token.symbol,   // "USDC", "USDT", "IDRX", "ETH", …
  toCurrency: dto.fiatCurrency, // "IDR"
  region: "ID",
});
```

The `ExchangeRate` hypertable already accepts arbitrary `fromCurrency` strings — adding tokens means seeding rate rows, not migrating schema. Per-token markup tuning happens via `ExchangeRate.markup` (already nullable + per-row).

**Native-token readiness (no code today, just invariants the design preserves):**
- `Token.isNativeCurrency` already exists and is consulted in `BlockchainVerificationService.initializeClients` (lines 51-86).
- Contract `processMerchantPayment` is `payable` and branches on `tokenAddress == address(0)`.
- Adapter passes `address(0)` as `expectedTokenAddress` when `token.isNativeCurrency === true`. The contract verification helper already handles native-sentinel address comparison (`blockchain-verification.service.ts:386-390`).

**IDRX special case:** rate ≈ 1.0 (1 IDRX ≈ 1 IDR). Existing quote machinery handles it without modification — `fxRateSnapshot` is a `Decimal(36,18)` and accepts ≈1. Spread/markup still applies to cover off-ramp cost.

**Why Option C, not A or B:**
- **Option A (one intent per token-choice via a `/quotes` preview endpoint):** worth doing once mobile UX needs side-by-side token comparison. Not now — the picker shows balances, customer picks, intent is created.
- **Option B (multi-leg intent storing N quotes):** breaks the 1:1 intent↔refId↔contract-state invariant the rest of the design depends on. Don't.

### 4.9 Quote lifecycle — refresh, expiration, on-chain enforcement

**Quote TTL is per-rail:**
- `nanopay`: keep current `nanopayValidBefore + 60s buffer` (3 days + 1 h, dictated by Circle Gateway's `validBefore` floor — see `intents.service.ts:131`).
- `direct_arc` (onchain rail): **15 minutes** at quote-creation time. Matches the purchase-side booking TTL and bounds FX/gas exposure.

The `expiresAt` column already exists on `PaymentIntent`; only the per-`path` derivation rule changes:

```ts
const expiresAtSec = path === "direct_arc"
  ? nowSec + 15 * 60
  : nanopayValidBefore + 60;
```

**Re-quote without re-scan:** the merchant QR encodes only `merchantId` (signed JWS). It contains no quote data. So the customer can refresh as many times as needed against the same QR — each refresh is a fresh `POST /v1/pay/intents`.

```
scan QR once → cache merchantId in mobile state
                    │
                    ▼
user enters amount, picks token
                    │
                    ▼
POST /v1/pay/intents {merchantId, amountIdr, sourceTokenId}
   ├─ returns PaymentIntent { id, tokenAmount, expiresAt(T+15m),
   │                          quoteCommitment, quoteSignature }
   ├─ mobile shows countdown
   │
   ├─ if customer signs/pays before expiresAt:  → normal flow
   │
   └─ if countdown hits zero:
        mobile auto-fires POST /v1/pay/intents again with a NEW
        Idempotency-Key
          → fresh PaymentIntent, same merchant/amount/token, fresh fxRate,
            fresh signed quote
          → old intent times out via the QUOTED+expiresAt sweeper
```

**Wiring details:**

1. **Fresh `Idempotency-Key` per refresh.** The existing envelope (`intents.service.ts:141-165`) caches `(Idempotency-Key, bodyHash) → intentId` for 24h. Mobile must generate a new ULID per refresh; reusing the prior key returns the stale intent.
2. **Abandon-on-refresh (optional, recommended).** When a new intent is created for the same `(payer, merchant)` pair while a prior one is still `QUOTED`, mark the prior one `EXPIRED` early. Cleaner audit trail; not required for correctness — the sweeper using `@@index([status, expiresAt])` (`schema.prisma:910`) eventually reaps it.

**On-chain enforcement (hard reject of late payment):**

The contract reverts on `block.timestamp > quote.expiresAt` (§4.7). This means:
- A customer who broadcasts at T-1s but whose tx confirms at T+30s gets a **revert** — they pay gas, no tokens move, no intent state change.
- No off-chain "should we accept this past the deadline?" decision — eliminates a fuzzy-state failure mode.
- Customer's wallet shows the revert reason `QUOTE_EXPIRED`, mobile prompts re-quote.

This is strictly safer than a soft-grace window. The cost is a small UX sharp edge (mobile must show the countdown clearly + leave a 1-2 min safety margin in the displayed "valid until" time so customers don't broadcast at T-1s on purpose).

**No customer refund needed** for expired quotes — tokens never moved, the wallet just spent gas on a reverted call.

---

## 5. Schema Changes

### 5.1 New model: `OnchainSettlement`

Mirrors `NanopaySubmission` shape so the intent has symmetric history-tracking regardless of rail.

```prisma
model OnchainSettlement {
  id             String        @id @default(ulid())
  intent         PaymentIntent @relation(fields: [intentId], references: [id], onDelete: Cascade)
  intentId       String
  txHash         String
  chainId        Int
  confirmations  Int?
  verifiedAt     DateTime?     @db.Timestamptz()
  failureCode    String?
  failureMessage String?
  createdAt      DateTime      @default(now()) @db.Timestamptz()

  @@unique([intentId, txHash])
  @@index([txHash])
}
```

### 5.2 `PaymentIntent.path` semantics

No enum change — `direct_arc` already exists (`schema.prisma:799`). Repurposed as "settled via onchain TakumiWallet transfer on the EVM chain stored in `sourceChainId`." `nanopay` continues to mean "settled via Circle Gateway x402."

Future `x402` value is reserved for non-Circle x402 facilitators (pass-through rail).

### 5.3 `PaymentIntent` field renames + additions

| Action | Column | Notes |
|---|---|---|
| Rename | `usdcAmountMicros` → `tokenAmountMinor` (`BigInt`) | Token-agnostic. TOTAL customer pays (includes platform fee). Keep an alias view for one release if any external consumer reads the old name. |
| Rename | `usdcSourceChainId` → `sourceChainId` (`Int`) | Symmetry. |
| Add | `sourceTokenId String` (FK → `Token.id`) | Identifies the token the customer is paying with; populated from mobile picker (§4.8). |
| Add | `platformFeeAmountMinor BigInt` | Portion of `tokenAmountMinor` that is platform revenue. Matches `QuoteCommitment.platformFeeAmount` signed into the contract (§4.7a). `0` when `Token.platformFeeBps = 0`. |
| Add | `merchantBackingAmountMinor BigInt` | Convenience = `tokenAmountMinor - platformFeeAmountMinor`. Redundant but indexed for treasury reconciliation queries. |
| Add | `platformFeeBpsSnapshot Int` | BPS rate used at quote time. Snapshotted (not a live reference) so post-rate-change reconciliation still reproduces the quote. |
| Add | `quoteSignature Bytes` | EIP-712 signature returned to mobile + replayed into the contract. Persisted so backend can re-verify against historical signer if needed. |

`fxFromCurrency` already exists — populated from `token.symbol` instead of hardcoded `"USDC"`.

### 5.4 `Token` additions

```prisma
model Token {
  // existing columns...
  isPaymentEnabled Boolean @default(false) // Ops gate for merchant-rail acceptance
                                            // — distinct from isActive (which controls
                                            //   wallet display). v1 turns this on for
                                            //   USDC + USDT only.
  platformFeeBps   Int     @default(0)     // Platform fee in basis points (0..1000 valid).
                                            // Governance-set per token. Applied at quote
                                            // time (§4.7a); zero = no platform fee.
                                            // Per-merchant override can be layered on
                                            // top later via a MerchantTokenFeeOverride
                                            // table — not in v1.
}
```

### 5.5 `Blockchain` additions + confirmation tuning

```prisma
model Blockchain {
  // existing columns...
  takumiWalletContract String?  // EVM TakumiWallet deployment address (per chain)
  quoteSignerAddress   String?  // Public address corresponding to the per-chain quote signer
                                 // private key. Backend reads this to verify it's signing
                                 // with the same key the contract is configured to accept.
                                 // Mismatch → fail-fast at adapter init.
  minConfirmations     Int?     // Per-chain override of ONCHAIN_MIN_CONFIRMATIONS env.
                                 // Falls through to env if null.
}
```

`quoteSignerAddress` lives in DB rather than env so multi-chain deployments can rotate per-chain signers independently.

**Per-chain confirmation tuning (resolves §11 open question):**

The principle is **"~180 seconds of wallclock finality"** — converted to blocks by the chain's block time. Fast L2s need MORE blocks than Ethereum L1 to reach equivalent economic finality, because each block is cheaper to produce (and historically, cheaper to reorg). The 12-block default for the purchase path is calibrated to Ethereum L1; L2s must be retuned.

Initial tuning table — ops MUST populate `Blockchain.minConfirmations` per chain before it's flipped `isActive`:

| Chain | Block time | `minConfirmations` | Wallclock | Notes |
|---|---|---|---|---|
| Ethereum mainnet | ~12 s | 12 | ~144 s | Reference; matches existing purchase rail. |
| Arbitrum One | ~0.25 s | 720 | ~180 s | Sequencer-dependent; finality via L1 posting is the real guarantee (hours), but 180 s of L2 head is good enough for merchant-payment scale. |
| Optimism / Base | ~2 s | 90 | ~180 s | Same L2 caveat as Arbitrum. |
| Polygon PoS | ~2.2 s | 256 (~9 min) | ~560 s | Higher than 180 s because PoS checkpoints to Ethereum every ~34 min — extra buffer accounts for checkpoint lag. |
| BSC | ~3 s | 60 | ~180 s | |
| Arc testnet | ~2 s | 90 | ~180 s | Match Base/OP profile. |
| Solana | n/a | — | — | Out of scope for this spec. |

Ops process when onboarding a new chain:
1. Measure median block time over a 24-h window.
2. Compute `minConfirmations = ceil(180 / block_time_s)`.
3. Add a 2× safety factor for PoS checkpoint-based chains.
4. Set `Blockchain.minConfirmations`.
5. Run the chain on testnet for ≥ 1 week before marking `isActive = true`.
6. Subscribe to the chain's reorg-history monitoring (or build one if none exists); re-tune if observed depth exceeds `minConfirmations / 2`.

Global env `ONCHAIN_MIN_CONFIRMATIONS` remains as the fallback for chains without an explicit value — defaulting to `12` preserves the existing purchase-rail behavior if the column is unpopulated.

### 5.6 `ProviderPayout` — no change

The downstream disbursement row is rail-agnostic by design (`schema.prisma:929-957`). `intentId` FK is the join; `provider` column tracks Xendit/Duitku, independent of how the intent settled.

---

## 6. Environment Variables

| Var | Values | Default | Purpose |
|---|---|---|---|
| `PAYMENT_SETTLEMENT_RAIL` | `nanopay` \| `onchain` | `nanopay` | Default rail when `PaymentIntent.path` is unspecified at creation. |
| `ONCHAIN_MIN_CONFIRMATIONS` | positive int | inherits `MIN_CONFIRMATIONS` (12) | Per-rail override. Only consulted by `OnchainSettlementProvider`. Leave unset to inherit. Per-chain `Blockchain.minConfirmations` takes higher precedence. |
| `QUOTE_SIGNER_PRIVATE_KEY` | `0x…` (66 chars) | falls back to `ADMIN_WALLET_PRIVATE_KEY` | EIP-712 signer for `QuoteCommitment`. Setting this distinct from the admin key is the recommended posture for prod (different key rotation cadence). |
| `QUOTE_TTL_DIRECT_ARC_SECONDS` | positive int | `900` (15 min) | TTL applied to `PaymentIntent.expiresAt` for `path = direct_arc`. |
| `QUOTE_SIGNATURE_DOMAIN_NAME` | string | `"TakumiPay"` | EIP-712 domain name. Must match contract's domain separator. |
| `QUOTE_SIGNATURE_DOMAIN_VERSION` | string | `"1"` | EIP-712 domain version. Bump only on breaking quote-struct change (re-deploys contract). |

`backendSigner` on the contract is set at deploy time to the address derived from `QUOTE_SIGNER_PRIVATE_KEY` and persisted in `Blockchain.quoteSignerAddress` (§5.5). At service boot, `OnchainSettlementProvider` asserts `derivedAddress(QUOTE_SIGNER_PRIVATE_KEY) === Blockchain.quoteSignerAddress` for every active EVM chain — mismatch fails app boot loud, preventing silent signature rejection in prod.

Existing vars untouched: `MIN_CONFIRMATIONS`, `CIRCLE_X402_SUPPORTED_URL`, `CIRCLE_API_KEY`, `XENDIT_SECRET_KEY`, `DUITKU_*`.

---

## 7. Flow Diagrams

### 7.1 Onchain rail (new)

```
Customer scans merchant QR (signed JWS, encodes only merchantId)
      │
      ▼
Mobile: POST /v1/pay/intents  (Idempotency-Key, JWT)
        body: { merchantId, fiatAmountMinor, fiatCurrency,
                sourceTokenId, sourceChainId }
      │
      ▼
IntentsService.createIntent
      ├─ snapshot ExchangeRate (token.symbol → IDR)
      ├─ compute tokenAmountMinor from fiatAmountMinor / fxRate × markup
      ├─ persist PaymentIntent { path=direct_arc, status=QUOTED,
      │                          expiresAt=now+15m, refId=id }
      ├─ QuoteSignerService.sign(QuoteCommitment) → quoteSignature
      └─ return { intent, quoteCommitment, quoteSignature }
      │
      ▼
Mobile: shows countdown (expiresAt - 60s safety margin in UI)
      │
      ├─ if customer waits past expiresAt → re-fire POST /v1/pay/intents
      │   with new Idempotency-Key (same merchant/amount/token).
      │
      ▼
Customer confirms in wallet:
   TakumiWallet.processMerchantPayment(
     QuoteCommitment, backendSignature
   )                                                            [on-chain]
      │
      ▼
Contract checks (revert on any failure):
      ├─ block.timestamp <= quote.expiresAt        → QUOTE_EXPIRED
      ├─ !_consumedRefs[refId]                     → REF_CONSUMED
      ├─ ECDSA.recover(digest, sig) == backendSigner → BAD_QUOTE
      ├─ if native: msg.value == amount            → NATIVE_AMOUNT_MISMATCH
      └─ else: IERC20.transferFrom(payer, this, amount)
      │
      ▼
Tokens custodied by contract; MerchantPaymentProcessed event emitted.
      │
      ▼
Mobile: POST /v1/pay/intents/:id/onchain  { txHash, chainId }
      │
      ▼
SettlementOrchestrator.resolveProvider(intent.path) → "onchain"
      └─→ OnchainSettlementProvider.settle
            ├─ verifyTxReceiptOnly                              [viem]
            │   ├─ waitForTransactionReceipt(N confirmations)
            │   ├─ status == "success"
            │   ├─ from == intent.payer
            │   └─ to   == chain.takumiWalletContract
            ├─ verifyMerchantPaymentInContract                  [viem readContract]
            │   readContract(getMerchantPaymentByRef, refId) and compare:
            │     payer, merchantId, tokenAddress, amount,
            │     fiatAmountMinor, fiatCurrency, exchangeRateId
            ├─ persist OnchainSettlement
            └─ PaymentIntent.status = SETTLED
      │
      ▼
kickPayout(intent.id) — fire-and-forget
      │
      ▼
PayoutService.trigger → resolveProvider(merchant.payoutProvider)
      ├─→ XenditPayoutProvider.triggerPayout  (if "xendit")
      └─→ DuitkuPayoutProvider.triggerPayout  (if "duitku")
      │
      ▼
Persist ProviderPayout (status=PENDING) — IDR sent from ops float
      │
      ▼
Xendit/Duitku webhook → PayoutService → intent.status=PAID_OUT
      │
      ▼
Merchant's IDR account credited.
      │
      │   (Asynchronously, on ops schedule:)
      │   Treasury off-ramps accumulated tokens from contract → IDR
      │   to refill ops float. See §11a.
```

### 7.2 Nanopay rail (existing, unchanged)

Identical downstream from `kickPayout` onward. Only the "prove payment" box swaps out.

---

## 8. Failure Semantics (onchain rail)

### 8.1 Contract-level reverts (caught by mobile wallet pre-API)

These never reach the backend — wallet shows them via the revert reason string.

| Revert reason | Cause | Mobile UX |
|---|---|---|
| `QUOTE_EXPIRED` | `block.timestamp > quote.expiresAt` | Prompt re-quote; gas spent, no tokens moved. |
| `REF_CONSUMED` | refId already used (replay or backend-bug double-issue) | Prompt re-quote; surface ops alert if frequent. |
| `BAD_QUOTE` | Signature doesn't recover to current `backendSigner` (key rotation drift, forged quote, wrong domain) | Hard error; prompt re-quote. Backend telemetry alert — likely signer-mismatch incident. |
| `FEE_EXCEEDS_AMOUNT` | `quote.platformFeeAmount > quote.amount` — signed inconsistent split | Hard error. Should be impossible under normal backend operation; treat as P0 signer-service incident. |
| `NATIVE_AMOUNT_MISMATCH` | `msg.value != amount` for native-token call | Mobile bug; client-side validation should catch first. |
| `UNEXPECTED_NATIVE` | `msg.value != 0` for ERC-20 call | Mobile bug. |
| ERC-20 `transferFrom` revert | Insufficient allowance / balance | Mobile prompts approve flow + retry. |

### 8.2 Backend-side failures (after `POST /v1/pay/intents/:id/onchain`)

| Condition | Behavior |
|---|---|
| `waitForTransactionReceipt` timeout (60 s) | 202 / `SETTLING` — mobile polls, no state change. Retry-safe. |
| Receipt status `reverted` | `FAILED` — terminal. `failureCode=TX_REVERTED`. (Should be rare since contract-level reverts surface in §8.1; this catches gas-out / chain-issue reverts.) |
| `from != intent.payer` | `FAILED` — `SENDER_MISMATCH`. |
| `to != chain.takumiWalletContract` | `FAILED` — `RECIPIENT_MISMATCH`. |
| Contract `getMerchantPaymentByRef(refId)` returns zero-value struct | `FAILED` — `REF_NOT_ON_CHAIN`. Tx hit contract but `processMerchantPayment` was not the function called (or was called with a different refId). |
| Any field mismatch on `MerchantPayment` struct (payer / merchantId / token / amount / fiatAmountMinor / fiatCurrency / exchangeRateId) | `FAILED` — `CONTRACT_DATA_MISMATCH` + mismatched-field log line. Investigate as potential tampering. |
| Confirmations < required at first check | Re-enqueue via `blockchain-verification` queue (5 attempts, exp backoff — `queue.module.ts:54-60`). |
| Replay with same `(intentId, txHash)` | 200 — return prior `OnchainSettlement` row verbatim. |
| Different tx hash for same intent after `SETTLED` | 409 — `INTENT_ALREADY_SETTLED`. |

All backend failure codes feed `OnchainSettlement.failureCode` + get mapped to the wire response's existing `NanopayFailureCode` via a small translation table in the adapter. Mobile's failure handling stays rail-agnostic post-translation (it already speaks `NanopayFailureCode`).

---

## 9. Testing Strategy

1. **Unit** — `OnchainSettlementProvider.settle` covers all branches in §8 with a mocked `BlockchainVerificationService` (table-driven).
2. **Integration** — e2e test spinning the full `POST /v1/pay/intents/:id/onchain` → Xendit stub webhook → `PAID_OUT`. Mirror existing `test/provider-agnostic-payout-migration.e2e-spec.ts`.
3. **Fork-testnet** — on Arc testnet (existing seed) deploy the extended contract, fire a real `processMerchantPayment`, submit the hash, assert settlement. Reuses the deploy story from the purchase path.
4. **Selector tests** — `SettlementOrchestrator.resolveProvider` must round-trip both keys and fail loudly on an unknown value (copy the `payout.service.resolve-provider.spec.ts` template from d9703da).
5. **Regression** — full nanopay test suite must continue to pass untouched. `test/duitku-sandbox.e2e-spec.ts` stays green — payout is unchanged.

---

## 10. Rollout Plan

1. **Phase 0 (PR 1) — Contract on testnet.** Solidity extension with `processMerchantPayment` + `getMerchantPaymentByRef` + EIP-712 signer verification. Deploy to Arc testnet; set `backendSigner` to a dedicated testnet signer address. Solidity review + audit-lite.
2. **Phase 1 (PR 2) — Schema migration.** New `OnchainSettlement` model; column additions on `PaymentIntent` (`sourceTokenId`, `quoteSignature`), `Token` (`isPaymentEnabled`), `Blockchain` (`takumiWalletContract`, `quoteSignerAddress`, `minConfirmations`). Renames behind aliased reads. No code paths consume the new columns yet.
3. **Phase 2 (PR 3) — Settlement port + nanopay adapter refactor.** Introduce `IPaymentSettlementProvider`; wrap existing `IntentsService.submitNanopay` logic into `NanopaySettlementProvider`. Behavior-preserving — every existing test continues to pass. All callers funnel through `SettlementOrchestrator`.
4. **Phase 3 (PR 4) — Quote signer service.** Implement `QuoteSignerService` (EIP-712 signing of `QuoteCommitment`). Backend boot-time assertion: `derived(QUOTE_SIGNER_PRIVATE_KEY) == Blockchain.quoteSignerAddress` for every active EVM chain. `POST /v1/pay/intents` response now includes `{ quoteCommitment, quoteSignature }` for all paths (nanopay rail ignores them; harmless additive change).
5. **Phase 4 (PR 5) — Onchain adapter + endpoint.** `OnchainSettlementProvider` + `POST /v1/pay/intents/:id/onchain` + multi-token DTO change (`sourceTokenId`). Refactor `BlockchainVerificationService.verifyTransaction` into `verifyTxReceiptOnly` + `verifyMerchantPaymentInContract` + a backward-compat `verifyTransaction` wrapper. Gated behind `PAYMENT_SETTLEMENT_RAIL=onchain` env (staging-only).
6. **Phase 5 (PR 6) — Staging cutover.** Flip staging merchants to onchain rail. Validate full round-trip: customer scan → on-chain pay → backend verify → Xendit/Duitku sandbox disbursement. Run for 1-2 weeks; monitor revert reasons + reconcile drift.
7. **Phase 6 — Per-merchant preference.** Add `Merchant.preferredSettlementRail` once prod onchain has baked. Deferred until staging is stable.
8. **Phase 7 — Treasury off-ramp tooling.** See §11a.

The Solidity PR (Phase 0) is the longest-lead item. The API can develop against a stub adapter that bypasses on-chain verification in tests, then flip to the real testnet contract during Phase 4 e2e testing.

---

## 11. Open Questions

- **`exchangeRateId` as contract state**: storing a DB autoincrement id on-chain is a smell — brittle if we ever replay history against a fresh DB. Works for v1; revisit with a content-hash FX commitment (e.g. `keccak256(abi.encodePacked(pair, rate, timestamp))`) in Phase 6.
- **Quote signer rotation runbook**: rotation requires (1) generate new key, (2) call contract `rotateBackendSigner(newAddress)`, (3) update `Blockchain.quoteSignerAddress`, (4) update `QUOTE_SIGNER_PRIVATE_KEY` in env, (5) bounce service. Coordination across these steps must be documented before mainnet launch.
- **In-flight quote during signer rotation**: a quote signed by the prior key remains valid for 15 minutes after rotation. Either (a) the contract accepts both signers during a grace window, or (b) we accept that ~15 min of customer payments may revert with `BAD_QUOTE` post-rotation. Design choice — recommend (a) with a 30-min `previousSigner` slot on the contract.

**Resolved in rev 4** (previously open):
- ~~Per-chain reorg policy~~ → §5.5 confirmation-tuning table + ops onboarding process.
- ~~Fee capture~~ → §4.7a explicit on-chain `platformFeeAmount` field labeled in `QuoteCommitment` + `MerchantPayment`; bounded sweep via `sweepPlatformFees`; rate governed by `Token.platformFeeBps`.

---

## 11a. Treasury Off-Ramp — Named Assumption

**Not in scope of this spec, but explicitly named so it's not a surprise later.**

The customer pays tokens to the contract; the merchant receives IDR via Xendit/Duitku from the platform's IDR ops float. **Someone has to bridge the two.** That someone is the platform's treasury — not Circle, not the merchant, not the customer.

This was already true on the nanopay rail (where Circle abstracts it via the settle attestation), but the onchain rail puts the platform fully on the hook for token custody and off-ramp.

**Implications the design preserves headroom for, but does not solve here:**

1. **Per-token liquidity guardrails.** `Token.isPaymentEnabled` (§5.4) is the kill switch — flip to `false` if treasury can't off-ramp a token fast enough. A future `Token.dailyPaymentCapMinor` would let ops cap exposure per token without flipping the switch entirely.
2. **Spread tuning per token.** `ExchangeRate.markup` already exists per row. ETH markup must cover off-ramp slippage (volatile), USDC markup can be tighter (deep liquidity). Ops sets these.
3. **Contract sweep tooling.** Need an admin function (`sweep(token, recipient, amount)` gated by `onlyOwner`) so treasury can withdraw accumulated tokens to the off-ramp wallet. Trivial Solidity addition; flagged here so it lands in the same contract PR (Phase 0) rather than as a separate emergency redeploy.
4. **Reconciliation surface.** Backend should expose "outstanding token custody" (sum of `MerchantPayment.amount` per token, minus swept amounts) for ops dashboards. Trivial query against `OnchainSettlement` + chain reads.
5. **Off-ramp execution.** Manual OTC desk for v1 is acceptable. Programmatic DEX/CEX integration is a separate workstream.

**Action item:** treasury & finance review to sign off on (1)+(2) before Phase 6 staging cutover; engineering owns (3)+(4) inside Phase 0 + Phase 5.

---

## 12. Security Properties (audit-ready)

This section is the canonical reference for security review of the onchain rail. Every property below is a testable invariant — pre-launch checklist in §12.7 maps each one to a concrete test or audit artifact.

### 12.1 Trust boundaries

| Boundary | Trusted | Untrusted |
|---|---|---|
| Customer wallet → contract | `msg.sender` (authenticated by EVM) | All calldata fields |
| Mobile app → backend | JWT identity, request body shape | Body values (validated server-side) |
| Backend → contract | `QUOTE_SIGNER_PRIVATE_KEY` (HSM/KMS in prod) | Nothing else; contract treats backend like any other RPC client outside the signer |
| Contract → backend | `MerchantPaymentProcessed` event + `getMerchantPaymentByRef` view | Nothing — backend independently re-derives state from chain |
| Backend ↔ DB | Prisma queries assumed correct | DB row contents (compared against chain on every settlement) |
| Backend → Xendit/Duitku | Provider API key + webhook HMAC/token | All webhook bodies (signature-verified before consumption) |

The signer key is the **single root of trust** for the onchain rail's settlement authenticity. Compromise → full forgery (see §12.5).

### 12.2 Security invariants

Each invariant is stated as a positive guarantee with the mechanism that enforces it.

**I-1: No customer funds move without a backend-issued quote.**
Mechanism: `processMerchantPayment` reverts with `BAD_QUOTE` if `ECDSA.recover(digest, backendSignature) != backendSigner`. Revert is atomic — `transferFrom` / native `msg.value` capture occurs after the check.

**I-2: A signed quote cannot be mutated.**
Mechanism: EIP-712 typed-data signature covers the entire `QuoteCommitment` struct. Any single-field change produces a different digest → `BAD_QUOTE`.

**I-3: A signed quote cannot be replayed.**
Mechanism: `mapping(bytes32 => bool) _consumedRefs` keyed by `keccak256(refId)`. First successful payment sets the flag; second call reverts `REF_CONSUMED`. refId is `PaymentIntent.id` (ULID, server-generated, idempotent per `(Idempotency-Key, body-hash)`) — the backend cannot accidentally re-issue the same refId.

**I-4: Stale quotes cannot be redeemed.**
Mechanism: `require(block.timestamp <= quote.expiresAt, "QUOTE_EXPIRED")`. Hard reject; no soft grace. Contract reverts before any state change. Backend cannot accept a tx confirmed past `expiresAt` either — both gates close.

**I-5: Cross-chain / cross-deployment replay is impossible.**
Mechanism: EIP-712 domain separator includes `chainId` + `verifyingContract` (standard `_hashTypedDataV4` from OpenZeppelin). A quote signed for chain A's TakumiWallet won't validate against chain B's, even with the same signer key.

**I-6: Merchant PII never reaches the chain.**
Mechanism: Contract's `QuoteCommitment` and `MerchantPayment` structs reference merchants only by ULID. Bank account, QRIS PAN, holder name, and contact phone are columns on the off-chain `Merchant` table (`schema.prisma:843-846`) and never serialized into any `processMerchantPayment` call. Code review gate: any future struct addition that names a PII-shaped field fails review.

**I-7: Payer identity cannot be spoofed.**
Mechanism: contract uses `msg.sender` for `MerchantPayment.payer`, not a calldata field. Backend's `verifyTxReceiptOnly` independently asserts `transaction.from === intent.payer.walletAddress` against the receipt. Two independent checks on the same property.

**I-8: Backend cannot fabricate a settlement post-hoc.**
Mechanism: backend's `OnchainSettlement` row requires `getMerchantPaymentByRef(refId)` to return a non-zero struct matching the intent. The chain is the source of truth; the DB row is an indexed projection. A malicious backend operator cannot mark `intent.status = SETTLED` without a real on-chain payment having occurred (without also editing the verification code, which is a code-review-detectable change).

**I-9: Disbursement is bounded by settlement.**
Mechanism: `PayoutService.trigger` is called only from inside `SettlementOrchestrator` after `intent.status` transitions to `SETTLED`. The intent → ProviderPayout FK (`schema.prisma:933`) prevents orphan payouts; `onDelete: Restrict` (line 933) prevents intent deletion while a payout exists. Code-path audit: search for direct `payoutService.trigger` callers — should be only `SettlementOrchestrator` and the existing `IntentsService.kickPayout`.

**I-10: Treasury custody is recoverable.**
Mechanism: contract exposes `sweep(token, recipient, amount) onlyOwner`. Funds custodied under any refId can be withdrawn by the owner key — guarantees no class of bug (e.g., a corrupt `_payments` entry) can permanently lock funds. Owner key MUST be a multi-sig in prod (§12.5).

**I-11: Front-running is economically self-defeating.**
Mechanism: `safeTransferFrom(msg.sender, this, amount)` pulls from the front-runner's address, not the original signer's. Anyone who steals a signed quote from the mempool pays the tokens themselves to fulfill it. The merchant gets paid either way; the front-runner gains nothing.

**I-12: Webhook callbacks cannot forge payouts.**
Mechanism: `PayoutService.verifyXenditWebhookSignature` (and Duitku equivalent) verify provider HMAC/token before mutating `ProviderPayout.status`. Already in place per `payout.service.ts:147-152`. No change required for the onchain rail — disbursement is rail-agnostic.

**I-13: Platform fee withdrawal is bounded by cumulative accrual.**
Mechanism: `sweepPlatformFees(token, recipient, amount)` requires `amount <= platformFeeAccrued[token]` and decrements the counter atomically. Platform treasury cannot accidentally (or maliciously via compromised owner) dip into merchant-backing custody via the fee-sweep function. A bug in the fee-bps math upstream is upper-bounded by the accrued counter — it cannot extract more than was labeled as fee in actual payments. Merchant-backing sweep (`sweepMerchantBacking`) uses a separate code path, making the blast radius of a compromised owner key auditable (the two sweep events are distinct). Since contract 2.3.0 it cannot take the balance backing accrued fees, and every exit shares a per-token cap that no 24h span can exceed.

**I-14: Per-chain finality threshold is enforced at settlement time.**
Mechanism: `OnchainSettlementProvider.minConfirmations(chain)` (§4.4) resolves in order: `Blockchain.minConfirmations` → `ONCHAIN_MIN_CONFIRMATIONS` env → `MIN_CONFIRMATIONS` env → `12`. viem's `waitForTransactionReceipt({ confirmations })` enforces the value. A misconfigured chain (null `minConfirmations`, no env override) falls back to 12 — safe for L1, potentially insufficient for fast L2s; the pre-launch checklist (§12.7 item 16) gates this.

### 12.3 Threat model & attack tree

**Attacker profiles:**
- **External attacker** (no credentials) — can call any `external` contract function, observe mempool, send arbitrary HTTP to backend.
- **Malicious customer** (valid JWT, holds tokens) — can create intents, pay or refuse to pay, attempt fabrication.
- **Compromised mobile** (attacker controls customer's app) — can construct arbitrary contract calls + arbitrary backend requests.
- **Compromised merchant** (valid merchant credentials) — can create QR, modify their own merchant row.
- **Compromised backend operator** (DB write access) — can flip flags, insert rows.
- **Compromised quote signer key** — root-of-trust loss; see §12.5.

**Attack tree:**

```
Goal: extract value or grief the system
│
├─ A1. Fake settlement (merchant gets IDR without customer paying)
│   │
│   ├─ Forge contract event without paying     → BLOCKED by I-1, I-2 (no event without successful tx)
│   ├─ Backend marks intent SETTLED via DB    → DETECTED by I-8 (settlement requires chain re-read)
│   └─ Webhook spoof to set status=COMPLETED  → BLOCKED by I-12 (signature verify on webhook)
│
├─ A2. Steal customer funds
│   │
│   ├─ Front-run signed quote in mempool       → BLOCKED by I-11 (front-runner pays from own address)
│   ├─ Replay old payment to drain again       → BLOCKED by I-3 (REF_CONSUMED)
│   └─ Modify amount in transit                → BLOCKED by I-2 (BAD_QUOTE)
│
├─ A3. Pay less than quoted (customer attack)
│   │
│   ├─ Reduce `amount` field in calldata       → BLOCKED by I-2
│   ├─ Use a stale-but-favorable quote         → BLOCKED by I-4 (QUOTE_EXPIRED)
│   └─ Pay native instead of ERC-20            → BLOCKED by I-2 (tokenAddress mismatch)
│
├─ A4. Grief / DoS
│   │
│   ├─ Send arbitrary tokens to contract       → No state effect; sweep() recovers (I-10)
│   ├─ Spam fabricated processMerchantPayment  → BLOCKED by I-1 (each call reverts; gas cost on attacker)
│   └─ Spam intent creation                    → Mitigated by existing rate limit (BOOKING_RATE_LIMIT_*)
│
├─ A5. Cross-chain / cross-deployment confusion
│   │
│   └─ Replay testnet quote on mainnet         → BLOCKED by I-5 (domain separator)
│
├─ A6. PII exfiltration via chain
│   │
│   └─ Read merchant bank account from event   → BLOCKED by I-6 (PII never on-chain)
│
└─ A7. Permanent fund lock
    │
    ├─ Contract bug locks _payments[ref]       → MITIGATED by I-10 (sweep recovers)
    └─ backendSigner key lost                   → MITIGATED by rotateBackendSigner; existing
                                                  refIds with old signer remain payable until
                                                  expiresAt (max 15 min exposure)
```

Every leaf is either BLOCKED (hard mechanism) or MITIGATED (recoverable with bounded loss). No leaf is OPEN.

### 12.4 Cryptographic primitives & assumptions

| Primitive | Where | Library | Assumption |
|---|---|---|---|
| EIP-712 typed data hashing | Quote signature | OpenZeppelin `EIP712.sol` (Solidity), `viem.signTypedData` (backend) | Standard EIP-712 implementations are correct. Both libs are widely audited. |
| ECDSA secp256k1 | Quote signature recovery | OpenZeppelin `ECDSA.sol` | secp256k1 hardness; signature malleability handled by `ECDSA.recover` (rejects high-s). |
| keccak256 | refId hashing for `_consumedRefs` map key | EVM builtin | Collision resistance of keccak256. ULIDs are 26-char ASCII; collision probability is negligible. |
| HMAC / static token | Xendit/Duitku webhook auth | Existing `payout.service.ts` — unchanged | Provider's signature scheme is correct (out of our scope). |
| AES (envelope) | `Merchant.payoutAccountNumber` at-rest encryption | TODO per `merchants.service.ts:119-126` (currently UTF-8 plaintext placeholder) | **PRE-LAUNCH BLOCKER**: must complete the envelope-encryption work (task 45) before prod. |

Notable non-assumption: we do **not** assume RPC integrity. Backend re-reads on-chain state via viem `readContract` after waiting for confirmations — a malicious RPC that lies on `getMerchantPaymentByRef` would be detected on the next health-check (multi-RPC reads diverge), and the 12-confirmation gate plus event log gives independent observers the same source of truth.

### 12.5 Key management

| Key | Role | Storage (v1) | Storage (prod target) | Rotation |
|---|---|---|---|---|
| `QUOTE_SIGNER_PRIVATE_KEY` | Sign EIP-712 quotes | env var | KMS / HSM, accessed via signing service interface | Per-chain on operational schedule; on suspected compromise immediately. Use `rotateBackendSigner` on contract + update `Blockchain.quoteSignerAddress` + bounce service. |
| `ADMIN_WALLET_PRIVATE_KEY` | Existing admin ops (purchase verification fee-payer, contract admin) | env var | Multi-sig (Safe) for `onlyOwner` calls | Existing process. |
| Contract `owner` (for `rotateBackendSigner`, `sweep`) | Governance | EOA = `ADMIN_WALLET_PRIVATE_KEY` | **Multi-sig (Safe) — m-of-n required** | N/A in v1; multi-sig migration is a pre-prod step. |
| Xendit / Duitku API keys | Disbursement | env var (existing) | KMS | Existing process. |

**Key separation rules (enforced by code review):**
- `QUOTE_SIGNER_PRIVATE_KEY` MUST NOT be the same as `ADMIN_WALLET_PRIVATE_KEY` in any non-dev environment. Enforced by a boot-time assertion on `NODE_ENV === "production"`.
- The signing service exposes only `signQuote(commitment): Promise<Hex>`. The raw key is not readable by other services.
- Quote signing is rate-limited at the `IntentsService.createIntent` boundary (existing `BOOKING_RATE_LIMIT_*` envs). A bug that loops on quote signing has bounded impact.

**Compromise response runbook (§11 open Q expanded):**
1. Generate new key in HSM.
2. Multi-sig executes `rotateBackendSigner(newAddress)` on contract — adds new signer, keeps old in `previousSigner` slot.
3. Update `Blockchain.quoteSignerAddress` rows.
4. Update `QUOTE_SIGNER_PRIVATE_KEY` in env, deploy.
5. After 30 min (max quote TTL + buffer), call `clearPreviousSigner()` to disable the old key permanently.
6. Audit logs for any signed-but-unredeemed quotes from the compromised window; refund or honor based on case-by-case review.

### 12.6 Auditability

The chain is independently meaningful. With **only** access to the deployed `TakumiWallet` contract address and an archive node, a third party can reconstruct:

- **Total payments per merchant**: filter `MerchantPaymentProcessed` events by `indexed merchantId`.
- **Total payments per payer**: filter by `indexed payer`.
- **Total payments by refId**: filter by `indexed refId` (or `getMerchantPaymentByRef`).
- **Token-by-token volume**: aggregate `(tokenAddress, amount)` pairs.
- **IDR-equivalent volume**: `fiatAmountMinor + fiatCurrency` is on-chain.
- **Custody balance**: standard ERC-20 balance reads against the contract address; native via `eth_getBalance`.

The backend's `OnchainSettlement` table is a derived index — it can be rebuilt from chain at any time. This is the recovery path if the DB is lost.

### 12.7 Pre-launch security checklist

Items must be GREEN before mainnet rollout (Phase 6).

| # | Item | Owner | Verification |
|---|---|---|---|
| 1 | Solidity audit by external firm | Eng | Audit report signed off, all findings resolved or risk-accepted |
| 2 | EIP-712 domain separator includes chainId + verifyingContract | Eng | Static review of `_hashTypedDataV4` usage |
| 3 | `QUOTE_SIGNER_PRIVATE_KEY` distinct from admin key in prod | Eng/Ops | Boot-time assertion in code + env review |
| 4 | Contract owner is multi-sig, not EOA | Ops | On-chain check pre-launch |
| 5 | `Merchant.payoutAccountNumber` envelope encryption complete (task 45) | Eng | Security review of crypto envelope |
| 6 | `sweep()` function exists + multi-sig only | Eng | Solidity test + on-chain check |
| 7 | `rotateBackendSigner()` + 30-min `previousSigner` grace tested | Eng | Solidity test |
| 8 | All 14 invariants (§12.2) have at least one test | Eng | Test file index in PR |
| 9 | All attack-tree leaves (§12.3) have at least one test | Eng | Test file index in PR |
| 10 | Webhook signature verification tested with real provider replay | Eng | E2E test |
| 11 | Per-chain `Blockchain.quoteSignerAddress` populated for every active EVM chain | Ops | Boot-time assertion + DB query |
| 12 | Rate limits set on `POST /v1/pay/intents` | Ops | Env review |
| 13 | Token whitelist (`Token.isPaymentEnabled`) reviewed by treasury | Treasury | Sign-off |
| 14 | Per-token markup (`ExchangeRate.markup`) reviewed by treasury | Treasury | Sign-off |
| 15 | Compromise-response runbook walked through in tabletop drill | Ops/Eng | Drill report |
| 16 | Per-chain `Blockchain.minConfirmations` populated for every active EVM chain per the tuning table (§5.5) | Eng | Per-chain DB query + reorg-monitoring subscription confirmed |
| 16a | `sweepPlatformFees` bound check tested (cannot exceed `platformFeeAccrued[token]`) | Eng | Solidity test |
| 16b | Platform-fee reconciliation query documented: `Σ MerchantPayment.platformFeeAmount == platformFeeAccrued + Σ PlatformFeesSwept` | Eng/Ops | Dashboard + runbook |
| 16c | `Token.platformFeeBps` values signed off by finance for each enabled token | Treasury/Finance | Sign-off |
| 17 | Monitoring: alert on `BAD_QUOTE` revert spike (signal of attempted forgery or rotation drift) | Ops | Dashboard + alert configured |
| 18 | Monitoring: alert on `OnchainSettlement` failure rate > baseline | Ops | Dashboard + alert configured |
| 19 | DR drill: rebuild `OnchainSettlement` table from chain | Eng | Successful rebuild from archive node |
| 20 | Disclosure / bug-bounty program live before mainnet | Ops | Public program URL |

### 12.8 Out of scope for this security section

- Disbursement provider security (Xendit / Duitku) — covered by existing `payout.service.ts` review.
- General application security (authn/authz, input validation outside the rail) — covered by existing platform review.
- Solana parity — separate spec, separate audit.
- General Solidity safe-math, reentrancy posture — assumed standard practice; covered by external audit (item 1).

---

## 13. Non-Goals

- Changing how IDR disbursement works.
- Adding a third settlement adapter in this cycle.
- Migrating existing `nanopay`-path intents to the new rail.
- Supporting non-EVM chains on the onchain rail.
- Programmatic treasury off-ramp execution (manual for v1).
- Token-picker UX in mobile (assumed already built).
- Refactoring `NanopaySubmitResponseDto` to a rail-neutral name (worth doing, but cosmetic — separate cleanup).
