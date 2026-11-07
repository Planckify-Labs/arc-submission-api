import { createHash, randomBytes } from "node:crypto";
import { BN } from "@coral-xyz/anchor";
import type {
  GatewayDepositStatus,
  PaymentIntentStatus,
  ProviderPayoutStatus,
  TransactionStatus,
  TransactionType,
} from "@generated/prisma";
import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";
import * as nacl from "tweetnacl";
import { type Hash, type Hex, stringToHex } from "viem";
import { BlockchainVerificationService } from "../blockchain-verification/blockchain-verification.service";
import {
  NEEDS_REVIEW,
  SETTLEMENT_JOB_OPTIONS,
  type SettlementOutcome,
  TRANSIENT,
  TX_REVERTED,
  resolveMinConfirmations,
} from "../blockchain-verification/settlement-policy";
import { StellarVerificationService } from "../blockchain-verification/stellar-verification.service";
import { QrSigningService } from "../merchants/qr-signing.service";
import { PrismaService } from "../prisma/prisma.service";
import { PushService } from "../push/push.service";
import { TransactionsService } from "../transactions/transactions.service";
import { BlockchainCacheService } from "../valkey/services/blockchain-cache.service";
import { ValkeyService } from "../valkey/valkey.service";
import { X402SupportedService } from "../x402/x402-supported.service";
import {
  CIRCLE_SETTLE_SVM_CLIENT,
  type CircleSettleSvmOutcome,
  type ICircleSettleSvmClient,
} from "./circle-settle-svm.client";
import {
  CIRCLE_SETTLE_CLIENT,
  type CircleSettleOutcome,
  type ICircleSettleClient,
} from "./circle-settle.client";
import type { CreateIntentDto } from "./dto/create-intent.dto";
import type { DepositReceiptResponseDto } from "./dto/deposit-receipt.dto";
import type {
  NanopayFailureCode,
  NanopaySubmitResponseDto,
} from "./dto/nanopay-submit-response.dto";
import type {
  NanopayPayloadResponseDto,
  PaymentIntentResponseDto,
} from "./dto/payment-intent-response.dto";
import type { QuoteCommitmentResponseDto } from "./dto/quote-commitment-response.dto";
import { computePlatformFee } from "./platform-fee.util";
import { QuoteSignerService } from "./quote-signer.service";

/**
 * Soft-linked payout provider contract (spec §6.4 "Pluggable payout
 * provider"). Task 29 is the canonical implementation. We depend on it
 * **optionally** so this task can ship ahead of it without a hard wire.
 *
 * `trigger` is fire-and-forget — a thrown promise here must NOT
 * back-propagate into the HTTP 2xx response. The intent IS settled from
 * Circle's perspective, regardless of Xendit availability; task 30's
 * webhook is what flips the status to PAID_OUT.
 */
export interface IPayoutProvider {
  trigger(intentId: string): Promise<void> | void;
}
export const PAYOUT_PROVIDER = "PAYOUT_PROVIDER";

/**
 * Terminal-payout statuses at which we surface `payoutReferenceId` /
 * `settledAt` on the GET response. FAILED payouts are still terminal —
 * mobile needs the reference id for support-case lookups even on failure.
 */
const TERMINAL_PAYOUT_STATUSES = new Set<ProviderPayoutStatus>([
  "COMPLETED",
  "FAILED",
]);

/**
 * Arc Testnet chain id — the only settlement chain in M2 (task 20 seed).
 * Kept as a constant here rather than env-driven because the blockchain
 * row is seeded (not configured); swapping chain is a schema/seed change,
 * not a runtime flag.
 */
const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * Sentinel chain-ids for Solana (task 43 / spec §5.2.1 Path B-SVM).
 *
 * `PaymentIntent.nanopayUsdcSourceChainId` is a non-null `Int` in schema.prisma
 * (task 19 migration), so we can't store a null chainId for SVM intents
 * without a schema change. Instead we map the two Solana clusters to fixed
 * negative sentinels — negatives are outside the EIP-155 chainId space
 * (chainIds are positive ints by spec) and are matched below to the seeded
 * Solana `Blockchain` rows via `chainSlug` on lookup.
 *
 * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
 * these sentinels live in ONE place; intent-code switches on `isSvmChainId()`
 * (a single `blockchain.isEVM === false` predicate at the DB boundary) and
 * NOT on `if (chainId === -101)` arms in every call site.
 */
const SVM_MAINNET_SENTINEL_CHAIN_ID = -101;
const SVM_DEVNET_SENTINEL_CHAIN_ID = -102;

const SVM_SENTINEL_TO_CHAIN_SLUG: Record<number, string> = {
  [SVM_MAINNET_SENTINEL_CHAIN_ID]: "solana-mainnet",
  [SVM_DEVNET_SENTINEL_CHAIN_ID]: "solana-devnet",
};

/**
 * Stellar sentinel chainIds — same trick as the SVM sentinels above (Stellar
 * rows also have `chainId = null`). Distinct negative range so `isSvmChainId`
 * stays false for Stellar intents and the settlement path keys off
 * `blockchainId` / `blockchain.type === "STELLAR"`, never these numbers.
 */
const STELLAR_MAINNET_SENTINEL_CHAIN_ID = -201;
const STELLAR_TESTNET_SENTINEL_CHAIN_ID = -202;

/**
 * USDC SPL mint fallback — only used if the Token table lookup fails.
 * Prefer {@link IntentsService.resolveSvmUsdcMint} which reads from the DB.
 */
const USDC_SPL_MINT_MAINNET_FALLBACK =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Return true iff the chain-id is a SVM sentinel. Single predicate so
 * shared intent code stays chain-agnostic — callers that branch on this
 * funnel through one helper, matching the memory-note on chain-extension
 * discipline.
 */
export function isSvmChainId(chainId: number): boolean {
  return chainId < 0 && chainId in SVM_SENTINEL_TO_CHAIN_SLUG;
}

/**
 * Circle Gateway rejects `validBefore < now + 259_200` with
 * `authorization_validity_too_short`. We sign authorizations 3 days + 1 h
 * ahead to absorb clock skew between mobile, our API, and Circle without
 * tripping the guard on the slow path.
 *
 * The user-prompt scope described a 10-minute window. That number is from
 * an earlier iteration of the contract; Circle's current `validBefore`
 * floor is 3 days (spec §6.2 NanopayPayload, task file acceptance #4).
 * Using 10 min would make every settle fail — preserving interop wins.
 */
const NANOPAY_VALID_BEFORE_OFFSET_SECONDS = 259_200 + 3_600; // 3 days + 1 h

/**
 * Post-authorization grace on the DB row. `expires_at` is what the mobile
 * app uses to drive its "quote expired" toast — we keep a 60-s cushion
 * past `validBefore` so a signed-but-unsubmitted intent never appears
 * expired in the UI while Gateway would still accept the signature.
 */
const EXPIRES_AT_BUFFER_SECONDS = 60;

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 h (user-prompt scope §3 item 3).
const IDEMPOTENCY_KEY_PREFIX = "pay:intent:idem:";

/**
 * Status mapping: DB enum → mobile-facing lowercase contract
 * (`services/nanopay/types.ts:PaymentIntentStatus`). Keep in lockstep with
 * the mobile enum — a mismatch silently breaks the polling terminal check.
 */
/**
 * BullMQ queue that verifies an on-chain merchant payment after the client
 * has handed us the tx hash (`OnchainSettlementProcessor`). The client's
 * POST returns as soon as the hash is recorded; everything that needs the
 * chain — receipt, confirmations, contract record — happens here, retried
 * for as long as it takes, so the user is never held on a spinner for our
 * side of the work.
 */
export const ONCHAIN_SETTLEMENT_QUEUE = "onchain-settlement";
export const ONCHAIN_SETTLEMENT_JOB = "verify-settlement";

export interface OnchainSettlementJobData {
  intentId: string;
  txHash: string;
  blockchainId: string;
}

/**
 * The on-chain rail settles in whatever token the payer selected, but the
 * intent stores the amount as 6-decimal micros of that token (the column
 * name predates multi-token settlement). Give the client the token and
 * the amount in its own minor units so it never has to guess — a Monad
 * AUSD quote must read "2.97 AUSD", not "2.97 USDC".
 */
function sourceTokenFields(
  token: {
    id: string;
    symbol: string;
    decimals: number;
    contractAddress: string | null;
  } | null,
  amountMicros: bigint | null,
): Pick<
  PaymentIntentResponseDto,
  "sourceTokenId" | "sourceToken" | "tokenAmountMinor"
> {
  if (!token) return {};
  const scale = 10n ** BigInt(Math.max(token.decimals - 6, 0));
  return {
    sourceTokenId: token.id,
    sourceToken: {
      id: token.id,
      symbol: token.symbol,
      decimals: token.decimals,
      contractAddress: token.contractAddress,
    },
    tokenAmountMinor: ((amountMicros ?? 0n) * scale).toString(),
  };
}

const DB_TO_MOBILE_STATUS: Record<
  PaymentIntentStatus,
  PaymentIntentResponseDto["status"]
> = {
  QUOTED: "pending",
  SIGNED: "submitting",
  SETTLED: "paid",
  PAID_OUT: "paid_out",
  FAILED: "failed",
  EXPIRED: "expired",
};

interface IdempotencyEnvelope {
  bodyHash: string;
  intentId: string;
  createdAt: number;
}

interface ResolvedFx {
  exchangeRateId: number;
  exchangeRateCreatedAt: Date;
  fxRate: string; // Decimal as string — viem-style precision preservation.
  fxMarkup: string;
  fxFromCurrency: string;
  fxToCurrency: string;
  fxProvider: string;
  fxQuotedAt: Date;
}

/**
 * Build-intent handler for `POST /v1/pay/intents`.
 *
 * Responsibilities (spec §6.2, §6.5, §8.5 #3):
 *   1. Resolve merchant → 404 `MERCHANT_NOT_FOUND` on miss.
 *   2. Snapshot the latest FX row (USDC→IDR, region=ID) → 503 on miss.
 *   3. Compute USDC micros from (fiatAmountMinor / fxRate × markup).
 *   4. Generate a 32-byte random nonce; build the EIP-712 domain from the
 *      cached x402-supported response; pick the platform treasury from env.
 *   5. Persist `PaymentIntent` with `status = QUOTED`.
 *   6. Idempotency: `(Idempotency-Key, sha256(body))` cached in Valkey 24 h.
 *      Same key + same hash → return the existing intent. Same key + different
 *      hash → 409 Conflict (spec guarantee — retries must not silently change
 *      amounts).
 *
 * No on-chain calls here (Circle settle lives in task 24 — `/nanopay` submit
 * handler). This endpoint is DB + compute only.
 */
@Injectable()
export class IntentsService {
  private readonly logger = new Logger(IntentsService.name);
  private svmSignerKeypair: {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
    publicKeyBase58: string;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly valkey: ValkeyService,
    private readonly blockchainCache: BlockchainCacheService,
    private readonly x402Supported: X402SupportedService,
    private readonly config: ConfigService,
    @Inject(CIRCLE_SETTLE_CLIENT)
    private readonly circleSettle: ICircleSettleClient,
    @Optional()
    @Inject(PAYOUT_PROVIDER)
    private readonly payoutProvider: IPayoutProvider | null = null,
    @Optional()
    @Inject(BlockchainVerificationService)
    private readonly blockchainVerification: BlockchainVerificationService | null = null,
    @Optional()
    @Inject(StellarVerificationService)
    private readonly stellarVerification: StellarVerificationService | null = null,
    @Optional()
    @Inject(CIRCLE_SETTLE_SVM_CLIENT)
    private readonly circleSettleSvm: ICircleSettleSvmClient | null = null,
    private readonly qrSigning: QrSigningService,
    private readonly transactionsService: TransactionsService,
    @Optional()
    @Inject(QuoteSignerService)
    private readonly quoteSigner: QuoteSignerService | null = null,
    @Optional()
    @InjectQueue(ONCHAIN_SETTLEMENT_QUEUE)
    private readonly onchainSettlementQueue: Queue<OnchainSettlementJobData> | null = null,
    @Optional()
    @Inject(PushService)
    private readonly pushService: PushService | null = null,
  ) {
    const raw = this.config.get<string>("SOLANA_QUOTE_SIGNER_PRIVATE_KEY");
    if (raw) {
      try {
        const decoded = new Uint8Array(JSON.parse(raw));
        const pubBytes = decoded.slice(32);
        const bs58Chars =
          "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let num = BigInt(0);
        for (const b of pubBytes) num = num * 256n + BigInt(b);
        let b58 = "";
        while (num > 0n) {
          b58 = bs58Chars[Number(num % 58n)] + b58;
          num /= 58n;
        }
        for (const b of pubBytes) {
          if (b === 0) b58 = "1" + b58;
          else break;
        }
        this.svmSignerKeypair = {
          secretKey: decoded,
          publicKey: pubBytes,
          publicKeyBase58: b58,
        };
        this.logger.log(`[quote-signer] SVM loaded: ${b58}`);
      } catch {
        this.logger.warn(
          "[quote-signer] Failed to parse SOLANA_QUOTE_SIGNER_PRIVATE_KEY",
        );
      }
    } else {
      this.logger.warn(
        "[quote-signer] SOLANA_QUOTE_SIGNER_PRIVATE_KEY not set",
      );
    }
  }

  async createIntent(args: {
    dto: CreateIntentDto;
    idempotencyKey: string;
    payerAddress: string;
    payerUserId: string | null;
    /** Raw JSON body string for idempotency hashing — stable across retries. */
    rawBodyForHash: string;
  }): Promise<PaymentIntentResponseDto> {
    const { dto, idempotencyKey, payerAddress, payerUserId, rawBodyForHash } =
      args;

    if (!dto.merchantId && !dto.scannedPayload) {
      throw new BadRequestException({
        message: "Either `merchantId` or `scannedPayload` must be provided.",
        code: "MERCHANT_REFERENCE_REQUIRED",
      });
    }

    this.logger.log(
      `[createIntent] payer=${payerAddress} merchantId=${dto.merchantId ?? "via-scan"} fiatAmount=${dto.fiatAmountMinor} currency=${dto.currency} chain=${dto.preferredChain ?? "eip155"} idem=${redactKey(idempotencyKey)}`,
    );

    // Idempotency check before any DB writes. A retry that matches the
    // previous body returns the existing intent verbatim — never re-generates
    // the nonce (would break mobile's in-flight signature) and never makes
    // an extra DB row.
    const bodyHash = sha256Hex(rawBodyForHash);
    const cached = await this.lookupIdempotent(idempotencyKey);
    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        throw new ConflictException({
          message: "Idempotency-Key reused with a different request body.",
          code: "IDEMPOTENCY_KEY_CONFLICT",
        });
      }
      const existing = await this.prisma.paymentIntent.findUnique({
        where: { id: cached.intentId },
        select: { id: true },
      });
      if (existing) {
        // Delegate to `getIntent` rather than a bespoke idempotent-replay
        // serializer: the two used to diverge (`toResponseDto` never grew
        // the onchain-settlement fields — `quoteCommitmentStellar`,
        // `quoteCommitmentSvm`, `contractAddress`, `takumiPayContractId`,
        // etc. — that `getIntent` reconstructs), so a retried create
        // request with the same Idempotency-Key silently returned a quote
        // stripped of everything `pathOnchainSettlement*.ts` needs to pay.
        // One serializer, one source of truth.
        return await this.getIntent({
          intentId: existing.id,
          userId: payerUserId,
          walletAddress: payerAddress,
        });
      }
      // Cache points at a vanished row (prune + cold-read fell through race).
      // Treat as a fresh request — re-creating the intent is safer than 500ing.
      this.logger.warn(
        `Idempotency cache hit for key=${redactKey(idempotencyKey)} but intent row missing — re-creating.`,
      );
    }

    let merchant: Awaited<ReturnType<typeof this.prisma.merchant.findUnique>> =
      null;

    if (dto.merchantId) {
      merchant = await this.prisma.merchant.findUnique({
        where: { id: dto.merchantId },
      });
    } else if (dto.scannedPayload) {
      if (dto.scannedPayload.startsWith("takumipay:v1:")) {
        const resolvedId = await this.qrSigning.verifyAndExtractMerchantId(
          dto.scannedPayload,
        );
        merchant = await this.prisma.merchant.findUnique({
          where: { id: resolvedId },
        });
      } else {
        const qrisPan = extractQrisPan(dto.scannedPayload);
        if (qrisPan) {
          merchant = await this.prisma.merchant.findFirst({
            where: { qrisPan },
          });
        }
      }
    }

    if (!merchant) {
      throw new NotFoundException({
        message: "Merchant not found for the provided payload.",
        code: "MERCHANT_NOT_FOUND",
      });
    }
    if (!merchant.isActive) {
      throw new ForbiddenException({
        message: `Merchant ${dto.merchantId} is deactivated.`,
        code: "MERCHANT_DEACTIVATED",
      });
    }

    this.logger.log(
      `[createIntent] merchant resolved id=${merchant.id} name="${merchant.displayName}"`,
    );

    const settlementRail = this.config.get<string>(
      "PAYMENT_SETTLEMENT_RAIL",
      "nanopay",
    );
    const isOnchainRail =
      settlementRail === "takumipay" || settlementRail === "direct_arc";

    // On the on-chain rail the payer picks the token (`sourceTokenId`), so
    // the FX row must be keyed on THAT token's symbol (USDC→IDR, AUSD→IDR,
    // …), not a fixed USDC. Resolve it before the snapshot. The nanopay
    // rail is USDC-only by construction and keeps the fixed symbol.
    const onchainToken = isOnchainRail
      ? await this.resolveSourceToken(dto.sourceTokenId)
      : null;
    const fxFromCurrency = onchainToken?.symbol ?? "USDC";

    // FX snapshot — `<token>→<currency>` in region=ID. If no row exists yet
    // we degrade gracefully with a 503 rather than guess a rate or block
    // forever. Mobile surfaces this as "FX temporarily unavailable".
    const fx = await this.snapshotLatestFx(fxFromCurrency, dto.currency);
    if (!fx) {
      throw new ServiceUnavailableException({
        message: `FX rate unavailable for ${fxFromCurrency}→${dto.currency}.`,
        code: "FX_UNAVAILABLE",
      });
    }

    this.logger.log(
      `[createIntent] FX snapshot rate=${fx.fxRate} markup=${fx.fxMarkup} from=${fx.fxFromCurrency} to=${fx.fxToCurrency} provider=${fx.fxProvider}`,
    );

    if (isOnchainRail && onchainToken) {
      return this.createOnchainIntent({
        dto,
        merchant,
        fx,
        tokenRow: onchainToken,
        idempotencyKey,
        bodyHash,
        payerUserId,
      });
    }

    // Chain-namespace decision (task 43 / spec §5.2.1). `preferredChain` is
    // the payer-side hint; default is EVM for backward compatibility with
    // pre-task-43 clients. The server is authoritative — we never echo the
    // client's choice into a cross-namespace mix-up (an intent is one chain).
    //
    // Chain-extension discipline (memory): the branch below is the ONLY
    // place in the create flow where namespace matters. Downstream code
    // reads `intent.nanopayUsdcSourceChainId` + `isSvmChainId()` rather than
    // re-deriving the namespace.
    const namespace: "eip155" | "solana" =
      dto.preferredChain === "solana" ? "solana" : "eip155";

    let sourceChainId: number;
    let treasuryAddress: string;
    let x402Entry: ReturnType<
      X402SupportedService["getSupportedForChain"]
    > | null;
    let payerAddressForPersistence: string;
    let svmBlockchainRow: {
      id: string;
      chainSlug: string;
      x402FacilitatorUrl: string | null;
    } | null = null;

    if (namespace === "solana") {
      // SVM intent (task 43). Treasury comes from the SVM env; x402 domain
      // is the Solana facilitator's network entry. Pre-M6 the env may be
      // blank — we gate on that explicitly so the rail is a clean 503, not
      // a garbage-filled intent.
      treasuryAddress = this.config.get<string>(
        "PLATFORM_TREASURY_ADDRESS_SVM",
        "",
      );
      if (!treasuryAddress || treasuryAddress.trim().length === 0) {
        this.logger.error(
          "[createIntent] PLATFORM_TREASURY_ADDRESS_SVM is not set or empty — SVM intents disabled",
        );
        throw new ServiceUnavailableException({
          message: "SVM payment rail is not available on this deployment.",
          code: "SVM_TREASURY_NOT_CONFIGURED",
        });
      }

      // Facilitator URL is the second half of the same gate — the intent
      // is useless if we can't forward it later. Check at quote time so
      // mobile gets the 503 up front rather than after signing.
      svmBlockchainRow = await this.resolveSvmBlockchainRow(
        SVM_MAINNET_SENTINEL_CHAIN_ID,
      );
      if (!svmBlockchainRow?.x402FacilitatorUrl) {
        this.logger.error(
          "[createIntent] x402FacilitatorUrl not set on SVM blockchain row (chainId=SVM_MAINNET_SENTINEL) — SVM intents disabled",
        );
        throw new ServiceUnavailableException({
          message: "SVM payment rail is not available on this deployment.",
          code: "SVM_FACILITATOR_NOT_CONFIGURED",
        });
      }

      // Default to mainnet-beta for the sentinel. Devnet is reachable via
      // a future DTO field; for the task-43 cut we mint mainnet intents.
      sourceChainId = SVM_MAINNET_SENTINEL_CHAIN_ID;

      // Try Circle's x402/supported entry for `solana:mainnet` — if Circle
      // lists SVM natively, it carries the facilitator feePayer. Otherwise
      // we use an external facilitator and the mobile signer derives the
      // feePayer from the base64 transaction itself.
      x402Entry =
        this.x402Supported.getSupportedForNetwork("solana:mainnet") ??
        this.x402Supported.getSupportedForNetwork("solana:mainnet-beta");

      payerAddressForPersistence = payerAddress; // base58 pubkey — we don't
      // re-validate the shape here because Solana pubkeys are 32 bytes in
      // an arbitrary base58 alphabet length (32..44 chars). We trust the
      // SIWS-issued JWT's `walletAddress` and let the facilitator reject
      // a mismatch as `invalid_signature`.
    } else {
      // EVM path — unchanged from M2. The x402-supported cache is the source
      // of truth for the EIP-712 domain (spec §6.5).
      sourceChainId = ARC_TESTNET_CHAIN_ID;
      x402Entry = this.x402Supported.getSupportedForChain(ARC_TESTNET_CHAIN_ID);
      if (
        !x402Entry ||
        !x402Entry.domainName ||
        !x402Entry.domainVersion ||
        !x402Entry.verifyingContract ||
        !x402Entry.asset
      ) {
        this.logger.error(
          `[createIntent] x402 domain not available for chainId=${ARC_TESTNET_CHAIN_ID} — check CIRCLE_X402_SUPPORTED_URL and boot-time fetch`,
        );
        throw new ServiceUnavailableException({
          message: "EVM payment rail is not available on this deployment.",
          code: "X402_DOMAIN_UNAVAILABLE",
        });
      }

      const evmTreasury = this.config.get<string>(
        "PLATFORM_TREASURY_ADDRESS_EVM",
      );
      if (!evmTreasury || !/^0x[0-9a-fA-F]{40}$/.test(evmTreasury)) {
        this.logger.error(
          "[createIntent] PLATFORM_TREASURY_ADDRESS_EVM is not set or invalid — EVM intents disabled",
        );
        throw new ServiceUnavailableException({
          message: "EVM payment rail is not available on this deployment.",
          code: "TREASURY_NOT_CONFIGURED",
        });
      }
      treasuryAddress = evmTreasury;

      if (!/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) {
        throw new BadRequestException({
          message: "Payer wallet address is not a valid EVM address.",
          code: "PAYER_ADDRESS_INVALID",
        });
      }
      payerAddressForPersistence = payerAddress;
    }

    // Amount math — deliberately in bigint + a Decimal-style string parser.
    // IDR 15_000 at 15700 IDR/USDC with a 1.5% markup →
    //   usdc = 15000 / 15700 × 1.015 = 0.969745... → 969746 micros.
    // See computeUsdcMicros for the full algorithm.
    const markupMultiplier = addMarkup(fx.fxMarkup);
    const nanopayUsdcAmountMicros = computeUsdcMicros({
      fiatAmountMinor: BigInt(dto.fiatAmountMinor),
      fxRate: fx.fxRate,
      markupMultiplier,
    });
    if (nanopayUsdcAmountMicros <= 0n) {
      throw new BadRequestException({
        message:
          "Computed USDC amount is zero — fiat amount too small for current rate.",
        code: "USDC_AMOUNT_TOO_SMALL",
      });
    }

    // 32-byte crypto-random nonce. Never logged — compliance memo
    // `feedback_role_separation.md` treats authorization fields as secrets
    // until the authorization is consumed.
    const nonceBytes = randomBytes(32);
    const nonceHex = `0x${nonceBytes.toString("hex")}` as const;

    const nowSec = Math.floor(Date.now() / 1000);
    const validAfter = nowSec;
    const validBefore = nowSec + NANOPAY_VALID_BEFORE_OFFSET_SECONDS;
    const expiresAt = new Date(
      (validBefore + EXPIRES_AT_BUFFER_SECONDS) * 1000,
    );

    // Build the nanopay block now that nanopayUsdcAmountMicros / validAfter /
    // validBefore are known. Namespace decides which shape.
    let nanopayBlock: NanopayPayloadResponseDto;
    if (namespace === "solana") {
      nanopayBlock = {
        kind: "svm_partial_tx",
        cluster: "mainnet-beta",
        usdcMint:
          x402Entry?.asset ??
          (await this.resolveSvmUsdcMint(svmBlockchainRow!.id)),
        // Backend does NOT pre-build the Solana tx here (task 43 Constraints:
        // "if @solana/web3.js isn't in backend, skip parsing the signed tx
        // on backend"). Mobile's task-42 signer builds + signs; we forward
        // the opaque blob at submit time.
        transaction: undefined,
        feePayer: x402Entry?.authorizedSigners?.[0],
        sourceChainId,
        value: nanopayUsdcAmountMicros.toString(),
        validAfter,
        validBefore,
        // SVM intents omit the EIP-712 block — consumer discriminates on `kind`.
      } satisfies NanopayPayloadResponseDto;
    } else {
      nanopayBlock = {
        kind: "evm_eip3009",
        usdc: x402Entry!.asset as `0x${string}`,
        sourceChainId: ARC_TESTNET_CHAIN_ID,
        domain: {
          name: x402Entry!.domainName!,
          version: x402Entry!.domainVersion!,
          verifyingContract: x402Entry!.verifyingContract as `0x${string}`,
        },
        from: payerAddressForPersistence.toLowerCase() as `0x${string}`,
        to: treasuryAddress as `0x${string}`,
        value: nanopayUsdcAmountMicros.toString(),
        validAfter,
        validBefore,
        nonce: nonceHex,
      } satisfies NanopayPayloadResponseDto;
    }

    const created = await this.prisma.paymentIntent.create({
      data: {
        payerUserId: payerUserId,
        merchantId: merchant.id,
        fiatAmountMinor: dto.fiatAmountMinor,
        fiatCurrency: dto.currency,
        nanopayUsdcAmountMicros: nanopayUsdcAmountMicros,
        nanopayUsdcSourceChainId: sourceChainId,
        nanopayUsdcTreasuryAddress: treasuryAddress,
        exchangeRateId: fx.exchangeRateId,
        exchangeRateCreatedAt: fx.exchangeRateCreatedAt,
        fxRateSnapshot: fx.fxRate,
        fxMarkupSnapshot: fx.fxMarkup,
        fxFromCurrency: fx.fxFromCurrency,
        fxToCurrency: fx.fxToCurrency,
        fxProvider: fx.fxProvider,
        fxQuotedAt: fx.fxQuotedAt,
        feesNetworkUsdMicros: 0,
        feesPayoutMinor: 0,
        feesPlatformBps: 0,
        path: "nanopay",
        nanopayNonce: nonceBytes,
        nanopayValidAfter: validAfter,
        nanopayValidBefore: validBefore,
        gaslessMode: "nanopay",
        // SVM intents don't require a Gateway deposit — the payer's USDC-SPL
        // ATA is the source of funds and Circle's facilitator bills itself
        // for fee-payer Lamports. EVM stays `requiresDeposit: true` pending
        // task-38's deposit-receipt flow.
        requiresDeposit: namespace === "eip155",
        status: "QUOTED",
        expiresAt,
      },
      include: { merchant: true },
    });

    await this.persistIdempotent(idempotencyKey, {
      bodyHash,
      intentId: created.id,
      createdAt: Date.now(),
    });

    this.logger.log(
      `[createIntent] nanopay intent created id=${created.id} usdcMicros=${nanopayUsdcAmountMicros} chainId=${sourceChainId} merchant=${merchant.id} status=QUOTED`,
    );

    return {
      id: created.id,
      status: DB_TO_MOBILE_STATUS[created.status],
      nanopayUsdcAmountMicros: nanopayUsdcAmountMicros.toString(),
      nanopayUsdcSourceChainId: sourceChainId,
      nanopayUsdcTreasuryAddress: treasuryAddress,
      nanopay: nanopayBlock,
      expiresAt: expiresAt.getTime(),
    };
  }

  /**
   * Builds + signs the EVM `QuoteCommitment` that `processMerchantPayment`
   * verifies on-chain, returning both the wire shape and the signature.
   *
   * Called from BOTH `createOnchainIntent` and `getIntent`, and must stay a
   * single implementation. The mobile client polls `GET /pay/intents/:id`
   * every 3s and overwrites its local copy with the response, so a poll that
   * omitted these fields would erase the create response's quote and make
   * `pay-merchant.tsx` throw `MISSING_QUOTE` the moment the user confirms —
   * the exact trap the Stellar block documents. Re-deriving on read is safe
   * because ECDSA here is RFC-6979 deterministic: identical input yields a
   * byte-identical signature, so no signature is persisted.
   *
   * Returns `null` when the chain isn't EVM, has no `takumi_pay` contract
   * row, or no signer key is configured — callers then simply omit the
   * fields rather than emitting a half-built quote.
   */
  private async buildEvmMerchantQuote(p: {
    blockchain: { id: string; type: string; chainId: number | null };
    token: { contractAddress: string | null; decimals: number };
    refId: string;
    merchantId: string;
    amountMicros: bigint;
    platformFeeMicros: bigint;
    fiatAmountMinor: number;
    fiatCurrency: string;
    exchangeRateId: number;
    expiresAtSec: number;
  }): Promise<{
    commitment: QuoteCommitmentResponseDto;
    signature: string;
    contractAddress: string;
  } | null> {
    if (p.blockchain.type !== "EVM" || p.blockchain.chainId == null)
      return null;
    if (!this.quoteSigner) return null;

    const contract = await this.prisma.smartContract.findFirst({
      where: {
        blockchainId: p.blockchain.id,
        name: "takumi_pay",
        isActive: true,
      },
    });
    if (!contract) {
      this.logger.warn(
        `[buildEvmMerchantQuote] EVM chain ${p.blockchain.chainId} has no active "takumi_pay" SmartContract row — quote unsigned`,
      );
      return null;
    }

    // Intent amounts are 6-decimal USDC micros; scale into the token's own
    // units so the signed, submitted and on-chain amounts all agree. Mirrors
    // the Stellar block. This is a no-op for 6-decimal USDC (including Arc,
    // whose ERC-20 view at 0x3600…0000 reports 6) and only bites on a chain
    // whose settlement token has more precision.
    const scale = 10n ** BigInt(Math.max(p.token.decimals - 6, 0));

    // address(0) means native. On a native-alias chain like Arc the contract
    // rejects address(0) outright (`NativeDisabledOnAliasChain`, and it isn't
    // on the allowlist), so the token row MUST carry the ERC-20 address —
    // which it does, since the row is keyed by `contractAddress`.
    const tokenAddress = (p.token.contractAddress ??
      "0x0000000000000000000000000000000000000000") as `0x${string}`;

    const amount = p.amountMicros * scale;
    const platformFeeAmount = p.platformFeeMicros * scale;
    // bytes3, e.g. "IDR" -> 0x494452. `size: 3` right-pads, matching the
    // contract's bytes3 and mobile's `fiatCurrencyToBytes3`.
    const fiatCurrencyHex = stringToHex(p.fiatCurrency.slice(0, 3), {
      size: 3,
    }) as Hex;

    const signature = await this.quoteSigner.signQuote(
      {
        refId: p.refId,
        merchantId: p.merchantId,
        tokenAddress,
        amount,
        platformFeeAmount,
        fiatAmountMinor: BigInt(p.fiatAmountMinor),
        fiatCurrency: fiatCurrencyHex,
        exchangeRateId: BigInt(p.exchangeRateId),
        expiresAt: BigInt(p.expiresAtSec),
      },
      p.blockchain.chainId,
      contract.address as `0x${string}`,
    );

    return {
      // The wire shape carries the ISO code ("IDR"), not the bytes3 hex —
      // mobile re-derives the hex via `fiatCurrencyToBytes3` when encoding
      // calldata. Sending hex here would double-encode it on the client.
      commitment: {
        refId: p.refId,
        merchantId: p.merchantId,
        tokenAddress,
        amount: amount.toString(),
        platformFeeAmount: platformFeeAmount.toString(),
        fiatAmountMinor: p.fiatAmountMinor,
        fiatCurrency: p.fiatCurrency,
        exchangeRateId: p.exchangeRateId,
        expiresAt: p.expiresAtSec,
      },
      signature,
      contractAddress: contract.address,
    };
  }

  private buildSvmQuoteMessage(p: {
    refId: string;
    merchantId: string;
    tokenMint: string;
    amount: bigint;
    platformFeeAmount: bigint;
    fiatAmountMinor: bigint;
    fiatCurrency: string;
    exchangeRateId: bigint;
    expiresAt: bigint;
  }): Uint8Array {
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();
    const u32le = (n: number) => {
      const b = new ArrayBuffer(4);
      new DataView(b).setUint32(0, n, true);
      return new Uint8Array(b);
    };
    const u64le = (n: bigint) => {
      const b = new ArrayBuffer(8);
      new DataView(b).setBigUint64(0, n, true);
      return new Uint8Array(b);
    };
    const i64le = (n: bigint) => {
      const b = new ArrayBuffer(8);
      new DataView(b).setBigInt64(0, n, true);
      return new Uint8Array(b);
    };

    const refIdBytes = enc.encode(p.refId);
    parts.push(u32le(refIdBytes.length), refIdBytes);

    const merchantIdBytes = enc.encode(p.merchantId);
    parts.push(u32le(merchantIdBytes.length), merchantIdBytes);

    // token_mint: 32 bytes (zeros for native SOL, or decoded base58 mint)
    if (p.tokenMint === "native") {
      parts.push(new Uint8Array(32));
    } else {
      const bs58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let num = BigInt(0);
      for (const ch of p.tokenMint) {
        const i = bs58.indexOf(ch);
        if (i < 0) break;
        num = num * 58n + BigInt(i);
      }
      const bytes = new Uint8Array(32);
      for (let i = 31; i >= 0 && num > 0n; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
      }
      parts.push(bytes);
    }

    parts.push(u64le(p.amount));
    parts.push(u64le(p.platformFeeAmount));
    parts.push(u64le(p.fiatAmountMinor));

    const currBytes = new Uint8Array(3);
    for (let i = 0; i < Math.min(p.fiatCurrency.length, 3); i++)
      currBytes[i] = p.fiatCurrency.charCodeAt(i);
    parts.push(currBytes);

    parts.push(u64le(p.exchangeRateId));
    parts.push(i64le(p.expiresAt));

    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const msg = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
      msg.set(p, off);
      off += p.length;
    }
    return msg;
  }

  /**
   * Resolve the token the payer settles with on the on-chain rail: the
   * explicit `sourceTokenId`, else the first payment-enabled stablecoin.
   * Throws 400 `SOURCE_TOKEN_INVALID` when nothing usable is found. Runs
   * BEFORE the FX snapshot so the rate row can be keyed on the token's
   * own symbol.
   */
  private async resolveSourceToken(sourceTokenId: string | undefined) {
    const tokenRow = sourceTokenId
      ? await this.prisma.token.findUnique({
          where: { id: sourceTokenId },
          include: { blockchain: true },
        })
      : await this.prisma.token.findFirst({
          where: {
            isPaymentEnabled: true,
            isStablecoin: true,
            isActive: true,
          },
          include: { blockchain: true },
        });
    if (!tokenRow?.blockchain) {
      throw new BadRequestException({
        message: "No payment-enabled token available. Provide sourceTokenId.",
        code: "SOURCE_TOKEN_INVALID",
      });
    }
    return tokenRow;
  }

  private async createOnchainIntent(args: {
    dto: CreateIntentDto;
    merchant: { id: string; displayName: string; isActive: boolean };
    fx: ResolvedFx;
    tokenRow: Awaited<ReturnType<IntentsService["resolveSourceToken"]>>;
    idempotencyKey: string;
    bodyHash: string;
    payerUserId: string | null;
  }): Promise<PaymentIntentResponseDto> {
    const {
      dto,
      merchant,
      fx,
      tokenRow,
      idempotencyKey,
      bodyHash,
      payerUserId,
    } = args;

    this.logger.log(
      `[createOnchainIntent] merchant=${merchant.id} fiatAmount=${dto.fiatAmountMinor} currency=${dto.currency} userId=${payerUserId ?? "anonymous"}`,
    );

    const markupMultiplier = addMarkup(fx.fxMarkup);
    const usdcMicros = computeUsdcMicros({
      fiatAmountMinor: BigInt(dto.fiatAmountMinor),
      fxRate: fx.fxRate,
      markupMultiplier,
    });
    if (usdcMicros <= 0n) {
      throw new BadRequestException({
        message:
          "Computed USDC amount is zero — fiat amount too small for current rate.",
        code: "USDC_AMOUNT_TOO_SMALL",
      });
    }

    const bc = tokenRow.blockchain;
    let sourceChainId: number;
    if (bc.chainId != null) {
      sourceChainId = bc.chainId;
    } else if (bc.type === "STELLAR") {
      sourceChainId = bc.chainSlug?.includes("mainnet")
        ? STELLAR_MAINNET_SENTINEL_CHAIN_ID
        : STELLAR_TESTNET_SENTINEL_CHAIN_ID;
    } else if (
      bc.solanaCluster === "mainnet-beta" ||
      bc.chainSlug?.includes("mainnet")
    ) {
      sourceChainId = SVM_MAINNET_SENTINEL_CHAIN_ID;
    } else {
      sourceChainId = SVM_DEVNET_SENTINEL_CHAIN_ID;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((nowSec + 900) * 1000);

    const platformFeeBps = this.config.get<number>("PLATFORM_FEE_BPS", 0);
    const { totalAmount, platformFeeAmount, merchantBackingAmount } =
      computePlatformFee(usdcMicros, platformFeeBps);

    const created = await this.prisma.paymentIntent.create({
      data: {
        payerUserId,
        merchantId: merchant.id,
        fiatAmountMinor: dto.fiatAmountMinor,
        fiatCurrency: dto.currency,
        nanopayUsdcAmountMicros: totalAmount,
        nanopayUsdcSourceChainId: sourceChainId,
        nanopayUsdcTreasuryAddress: "",
        sourceTokenId: tokenRow.id,
        platformFeeAmountMinor: platformFeeAmount,
        merchantBackingAmountMinor: merchantBackingAmount,
        platformFeeBpsSnapshot: platformFeeBps,
        exchangeRateId: fx.exchangeRateId,
        exchangeRateCreatedAt: fx.exchangeRateCreatedAt,
        fxRateSnapshot: fx.fxRate,
        fxMarkupSnapshot: fx.fxMarkup,
        fxFromCurrency: fx.fxFromCurrency,
        fxToCurrency: fx.fxToCurrency,
        fxProvider: fx.fxProvider,
        fxQuotedAt: fx.fxQuotedAt,
        feesNetworkUsdMicros: 0,
        feesPayoutMinor: 0,
        feesPlatformBps: platformFeeBps,
        path: "takumipay",
        nanopayNonce: randomBytes(32),
        nanopayValidAfter: nowSec,
        nanopayValidBefore: nowSec + 900,
        gaslessMode: "none",
        requiresDeposit: false,
        status: "QUOTED",
        expiresAt,
      },
      include: { merchant: true },
    });

    await this.persistIdempotent(idempotencyKey, {
      bodyHash,
      intentId: created.id,
      createdAt: Date.now(),
    });

    this.logger.log(
      `[createOnchainIntent] intent created id=${created.id} usdcMicros=${totalAmount} chainId=${sourceChainId} merchant=${merchant.id} token=${tokenRow.id} status=QUOTED`,
    );

    // Build SVM quote commitment + signature for Solana intents
    let quoteCommitmentSvm: Record<string, string> | undefined;
    let quoteSignatureSvm: string | undefined;
    let backendSignerPubkey: string | undefined;

    const isSvm = isSvmChainId(sourceChainId);
    if (isSvm && this.svmSignerKeypair) {
      const refId = created.id;
      const tokenMint = tokenRow.contractAddress ?? "native";
      const expiresAtSec = Math.floor(expiresAt.getTime() / 1000);

      const message = this.buildSvmQuoteMessage({
        refId,
        merchantId: merchant.id,
        tokenMint,
        amount: totalAmount,
        platformFeeAmount,
        fiatAmountMinor: BigInt(dto.fiatAmountMinor),
        fiatCurrency: dto.currency,
        exchangeRateId: BigInt(fx.exchangeRateId),
        expiresAt: BigInt(expiresAtSec),
      });

      const sigBytes = nacl.sign.detached(
        message,
        this.svmSignerKeypair.secretKey,
      );

      quoteCommitmentSvm = {
        refId,
        merchantId: merchant.id,
        tokenMint,
        amount: totalAmount.toString(),
        platformFeeAmount: platformFeeAmount.toString(),
        fiatAmountMinor: dto.fiatAmountMinor.toString(),
        fiatCurrency: dto.currency,
        exchangeRateId: fx.exchangeRateId.toString(),
        expiresAt: expiresAtSec.toString(),
      };
      quoteSignatureSvm = Buffer.from(sigBytes).toString("base64");
      backendSignerPubkey = this.svmSignerKeypair.publicKeyBase58;

      await this.prisma.paymentIntent.update({
        where: { id: created.id },
        data: { quoteSignature: Buffer.from(sigBytes) },
      });
    } else if (isSvm) {
      this.logger.warn(
        "[createOnchainIntent] SVM intent but no signer keypair — quote unsigned",
      );
    }

    // Stellar `takumi_pay` quote — mirrors the SVM block. Delegates all
    // Soroban specifics (contract id, network passphrase, token SAC-id, XDR
    // signing) to StellarVerificationService.
    let quoteCommitmentStellar: Record<string, string> | undefined;
    let quoteSignatureStellar: string | undefined;
    let backendSignerPubkeyStellar: string | undefined;
    let takumiPayContractId: string | undefined;

    if (bc.type === "STELLAR" && this.stellarVerification) {
      // Intent amounts are 6-decimal USDC micros; Stellar USDC is 7-decimal
      // (every Stellar asset is 7dp). Scale into the token's own units so the
      // signed / submitted / on-chain / verified amounts all agree.
      const scale = 10n ** BigInt(Math.max(tokenRow.decimals - 6, 0));
      const signed = this.stellarVerification.buildMerchantQuoteSignature({
        blockchainId: bc.id,
        refId: created.id,
        merchantId: merchant.id,
        tokenCompound: tokenRow.contractAddress ?? "",
        amount: BigInt(totalAmount) * scale,
        platformFeeAmount: BigInt(platformFeeAmount) * scale,
        fiatAmountMinor: BigInt(dto.fiatAmountMinor),
        fiatCurrency: dto.currency,
        exchangeRateId: BigInt(fx.exchangeRateId),
        expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
      });
      if (signed) {
        quoteCommitmentStellar = signed.commitment;
        quoteSignatureStellar = signed.signatureBase64;
        backendSignerPubkeyStellar = signed.backendSignerPubkeyHex;
        takumiPayContractId = signed.contractId;
      } else {
        this.logger.warn(
          "[createOnchainIntent] Stellar intent but quote unsigned (no signer/contract)",
        );
      }
    }

    // EVM `takumi_pay` quote — the counterpart of the SVM and Stellar blocks
    // above. Without this an EVM intent came back with no `quoteCommitment` /
    // `quoteSignature`, so `executeOnchainSettlement` on mobile always threw
    // MISSING_QUOTE and the EVM onchain rail could never complete.
    const evmQuote = await this.buildEvmMerchantQuote({
      blockchain: bc,
      token: tokenRow,
      refId: created.id,
      merchantId: merchant.id,
      amountMicros: BigInt(totalAmount),
      platformFeeMicros: BigInt(platformFeeAmount),
      fiatAmountMinor: dto.fiatAmountMinor,
      fiatCurrency: dto.currency,
      exchangeRateId: fx.exchangeRateId,
      expiresAtSec: Math.floor(expiresAt.getTime() / 1000),
    });

    return {
      id: created.id,
      status: DB_TO_MOBILE_STATUS[created.status],
      path: "takumipay",
      merchantId: merchant.id,
      merchantDisplayName: merchant.displayName,
      fiatAmountMinor: dto.fiatAmountMinor,
      currency: dto.currency,
      fxRate: fx.fxRate,
      nanopayUsdcAmountMicros: totalAmount.toString(),
      ...sourceTokenFields(tokenRow, totalAmount),
      nanopayUsdcSourceChainId: sourceChainId,
      nanopayUsdcTreasuryAddress: "",
      nanopay: null,
      expiresAt: expiresAt.getTime(),
      createdAt: created.createdAt.getTime(),
      blockchainId: bc.id,
      quoteCommitmentStellar,
      quoteSignatureStellar,
      backendSignerPubkeyStellar,
      takumiPayContractId,
      quoteCommitmentSvm,
      quoteSignatureSvm,
      backendSignerPubkey,
      ...(evmQuote
        ? {
            quoteCommitment: evmQuote.commitment,
            quoteSignature: evmQuote.signature,
            contractAddress: evmQuote.contractAddress,
          }
        : {}),
    };
  }

  /**
   * `GET /v1/pay/intents/:id` — polling read for the receipt / progress UI.
   *
   * Read-only: this method NEVER mutates the DB. Status transitions happen
   * elsewhere (task 24 flips QUOTED → SETTLED on settle, task 30 flips
   * SETTLED → PAID_OUT on the Xendit webhook). The auto-expire projection
   * below is a *render-time* overlay — if the intent row is still QUOTED
   * but the wall clock is past `expiresAt`, we return `status: "expired"`
   * to the client so the UI treats the quote as terminal. The DB flip to
   * `EXPIRED` is an out-of-band cron concern for a follow-up task.
   *
   * Auth (scope §2): the requester must be EITHER the payer (matched by
   * `payerUserId` or `walletAddress` → same stopgap pattern as task 23's
   * create endpoint) OR the merchant owner (`merchants.userId`). Any other
   * user receives 403 — we deliberately do NOT fall through to 404 because
   * the row exists and the payer may one day want us to expose it to their
   * support contact; the semantics are clearer with an explicit 403.
   *
   * Spec refs: umkm-usdc-payout-spec.md §6.2, §6.3.
   */
  async getIntent(args: {
    intentId: string;
    userId: string | null;
    walletAddress: string | null;
  }): Promise<PaymentIntentResponseDto> {
    const { intentId, userId, walletAddress } = args;

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: {
        merchant: true,
        nanopaySubmissions: { orderBy: { submittedAt: "desc" } },
        payouts: { orderBy: { createdAt: "desc" } },
        payer: true,
        sourceToken: { include: { blockchain: true } },
        onchainSettlements: { select: { id: true }, take: 1 },
      },
    });
    if (!intent) {
      throw new NotFoundException({
        message: `PaymentIntent ${intentId} not found.`,
        code: "PAYMENT_INTENT_NOT_FOUND",
      });
    }

    // Authorization check. Three ways a caller can be authorized:
    //   1) They're the payer by userId (set when the quote was created via a
    //      SIWE-issued JWT that carried `sub`).
    //   2) They're the payer by wallet address (header stopgap — matches
    //      task 23's `X-Payer-Address` fall-through for legacy tokens).
    //      We compare case-insensitively because EIP-55 addresses survive
    //      round-trips in mixed case.
    //   3) They're the merchant owner by `merchants.userId`.
    // Anything else: 403. Spec §6.3: never leak existence-of-row details
    // to unrelated callers.
    const normalizedCallerAddr = walletAddress?.toLowerCase() ?? null;
    const payerAddr = intent.payer?.walletAddress?.toLowerCase() ?? null;
    const isPayerByUserId =
      !!userId && !!intent.payerUserId && userId === intent.payerUserId;
    const isPayerByAddress =
      !!normalizedCallerAddr &&
      !!payerAddr &&
      normalizedCallerAddr === payerAddr;
    const isMerchantOwner = !!userId && userId === intent.merchant.userId;
    if (!isPayerByUserId && !isPayerByAddress && !isMerchantOwner) {
      // Uniform 403 — a controlled error that surfaces the auth boundary
      // without hinting whether the row exists for a different owner.
      throw new ForbiddenException({
        message: "You are not authorized to view this payment intent.",
        code: "PAYMENT_INTENT_FORBIDDEN",
      });
    }

    // Status projection. DB enum → mobile enum. Auto-expire overlay ONLY
    // when the DB still shows QUOTED — once the intent has been signed or
    // settled, `expiresAt` has no effect on state (Circle already has the
    // authorization).
    const nowMs = Date.now();
    const isAutoExpired =
      intent.status === "QUOTED" && intent.expiresAt.getTime() < nowMs;
    // SIGNED means "in flight" on every rail; for the on-chain rail the
    // hash is already recorded (an `onchainSettlements` row exists) and
    // the verifier is working — that is `settling` to the client, which
    // polls faster and shows "confirming" rather than "submitting".
    const isOnchainSettling =
      intent.status === "SIGNED" && intent.onchainSettlements.length > 0;
    const mobileStatus: PaymentIntentResponseDto["status"] = isAutoExpired
      ? "expired"
      : isOnchainSettling
        ? "settling"
        : DB_TO_MOBILE_STATUS[intent.status];

    // Nanopay block. Emit the signable payload while the intent is still
    // pre-settle (QUOTED + not auto-expired) so a mobile client that lost
    // its local cache can re-render the sign-confirm modal. Post-settle
    // the block is null per the mobile contract (`nanopay: NanopayPayload | null`).
    //
    // Chain-extension discipline (memory): the namespace dispatch is a
    // single `isSvmChainId` predicate — we build an SVM block OR an EVM
    // block, never a chimera.
    let nanopay: NanopayPayloadResponseDto | null = null;
    const sourceChainId = intent.nanopayUsdcSourceChainId ?? 0;
    const isSvm = isSvmChainId(sourceChainId);

    if (intent.status === "QUOTED" && !isAutoExpired && isSvm) {
      const svmEntry =
        this.x402Supported.getSupportedForNetwork("solana:mainnet") ??
        this.x402Supported.getSupportedForNetwork("solana:mainnet-beta");
      const svmRow = await this.resolveSvmBlockchainRow(sourceChainId);
      nanopay = {
        kind: "svm_partial_tx",
        cluster:
          sourceChainId === SVM_DEVNET_SENTINEL_CHAIN_ID
            ? "devnet"
            : "mainnet-beta",
        usdcMint:
          svmEntry?.asset ??
          (svmRow
            ? await this.resolveSvmUsdcMint(svmRow.id)
            : USDC_SPL_MINT_MAINNET_FALLBACK),
        feePayer: svmEntry?.authorizedSigners?.[0],
        sourceChainId,
        value: (intent.nanopayUsdcAmountMicros ?? 0n).toString(),
        validAfter: intent.nanopayValidAfter,
        validBefore: intent.nanopayValidBefore,
      };
    }

    const x402Entry = isSvm
      ? null
      : this.x402Supported.getSupportedForChain(sourceChainId);
    if (
      !isSvm &&
      intent.status === "QUOTED" &&
      !isAutoExpired &&
      x402Entry?.domainName &&
      x402Entry?.domainVersion &&
      x402Entry?.verifyingContract &&
      x402Entry?.asset
    ) {
      const nonceHex =
        `0x${Buffer.from(intent.nanopayNonce).toString("hex")}` as const;
      // `from` is populated from the joined payer row; if we don't have a
      // wallet for this user (legacy auth, header stopgap) we fall back to
      // the zero address — task 24's submit proxy recovers the real `from`
      // from the submitted signature, so this is not load-bearing on settle.
      const fromAddress = (
        intent.payer?.walletAddress ??
        "0x0000000000000000000000000000000000000000"
      ).toLowerCase() as `0x${string}`;
      nanopay = {
        kind: "evm_eip3009",
        usdc: x402Entry.asset as `0x${string}`,
        sourceChainId,
        domain: {
          name: x402Entry.domainName,
          version: x402Entry.domainVersion,
          verifyingContract: x402Entry.verifyingContract as `0x${string}`,
        },
        from: fromAddress,
        to: (intent.nanopayUsdcTreasuryAddress ?? "") as `0x${string}`,
        value: (intent.nanopayUsdcAmountMicros ?? 0n).toString(),
        validAfter: intent.nanopayValidAfter,
        validBefore: intent.nanopayValidBefore,
        nonce: nonceHex,
      };
    }

    // Payout terminality — surface the public `referenceId` + `completedAt`
    // only once the payout is actually terminal so mobile doesn't render a
    // half-baked reference id for a still-PROCESSING payout. We pick the
    // most recent payout row (ordered desc above); in practice there's one
    // per intent, but the order-by defends against a retry edge case.
    const latestPayout = intent.payouts[0];
    const isPayoutTerminal = latestPayout
      ? TERMINAL_PAYOUT_STATUSES.has(latestPayout.status)
      : false;
    const payoutReferenceId =
      isPayoutTerminal && latestPayout ? latestPayout.referenceId : undefined;
    const settledAt =
      isPayoutTerminal && latestPayout?.completedAt
        ? latestPayout.completedAt.getTime()
        : undefined;

    // Surface the smart-contract address / Solana program ID from the
    // source token's blockchain so the mobile OnchainCard can dispatch
    // without a second lookup.
    const blockchain = intent.sourceToken?.blockchain;
    const smartContract = blockchain
      ? await this.prisma.smartContract.findFirst({
          where: { blockchainId: blockchain.id, isActive: true },
          orderBy: { createdAt: "desc" },
        })
      : null;

    // Re-derive the EVM quote on every poll. See `buildEvmMerchantQuote` —
    // the client overwrites its local intent with each poll response, so
    // omitting these here would wipe the quote the create call returned.
    const evmQuote =
      blockchain && intent.sourceToken
        ? await this.buildEvmMerchantQuote({
            blockchain,
            token: intent.sourceToken,
            refId: intent.id,
            merchantId: intent.merchantId,
            amountMicros: intent.nanopayUsdcAmountMicros ?? 0n,
            platformFeeMicros: intent.platformFeeAmountMinor ?? 0n,
            fiatAmountMinor: intent.fiatAmountMinor,
            fiatCurrency: intent.fiatCurrency,
            exchangeRateId: intent.exchangeRateId,
            expiresAtSec: Math.floor(intent.expiresAt.getTime() / 1000),
          })
        : null;

    return {
      id: intent.id,
      status: mobileStatus,
      path: intent.path ?? undefined,
      merchantId: intent.merchantId,
      merchantDisplayName: intent.merchant.displayName,
      fiatAmountMinor: intent.fiatAmountMinor,
      currency: intent.fiatCurrency,
      fxRate: intent.fxRateSnapshot.toString(),
      nanopayUsdcAmountMicros: (
        intent.nanopayUsdcAmountMicros ?? 0n
      ).toString(),
      nanopayUsdcSourceChainId: sourceChainId,
      nanopayUsdcTreasuryAddress: intent.nanopayUsdcTreasuryAddress ?? "",
      nanopay,
      expiresAt: intent.expiresAt.getTime(),
      createdAt: intent.createdAt.getTime(),
      payoutReferenceId,
      settledAt,
      ...(intent.path === "takumipay"
        ? sourceTokenFields(intent.sourceToken, intent.nanopayUsdcAmountMicros)
        : {}),
      // Prefer the contract the quote was actually signed against — the
      // signature binds `verifyingContract`, so submitting to a different
      // address (the `findFirst` below is not filtered by name) would fail
      // signature recovery on-chain.
      contractAddress: evmQuote?.contractAddress ?? smartContract?.address,
      // `blockchain.takumiPayProgramId` was removed — it duplicated this same
      // `smartContract.address` lookup (name unfiltered here, so this
      // inherits that pre-existing looseness on chains with >1 active
      // SmartContract row; unchanged from before this field repoint).
      programId:
        blockchain && blockchain.type !== "EVM"
          ? smartContract?.address
          : undefined,
      blockchainId: blockchain?.id,
      ...(isSvm && intent.quoteSignature && intent.sourceToken
        ? {
            quoteCommitmentSvm: {
              refId: intent.id,
              merchantId: intent.merchantId,
              tokenMint: intent.sourceToken.contractAddress ?? "native",
              amount: (intent.nanopayUsdcAmountMicros ?? 0n).toString(),
              platformFeeAmount: (
                intent.platformFeeAmountMinor ?? 0n
              ).toString(),
              fiatAmountMinor: intent.fiatAmountMinor.toString(),
              fiatCurrency: intent.fiatCurrency,
              exchangeRateId: intent.exchangeRateId.toString(),
              expiresAt: Math.floor(
                intent.expiresAt.getTime() / 1000,
              ).toString(),
            },
            quoteSignatureSvm: Buffer.from(intent.quoteSignature).toString(
              "base64",
            ),
            backendSignerPubkey: this.svmSignerKeypair?.publicKeyBase58,
          }
        : {}),
      ...(evmQuote
        ? {
            quoteCommitment: evmQuote.commitment,
            quoteSignature: evmQuote.signature,
          }
        : {}),
      // Stellar counterpart of the SVM block above. Unlike SVM, the signed
      // quote isn't persisted on create (see `createOnchainIntent`) — Ed25519
      // signing is deterministic (RFC 8032), so re-deriving via the same
      // `buildMerchantQuoteSignature` helper on every poll reproduces byte-
      // identical output without a schema change. Without this the mobile
      // client's `useIntentStatus` poll (every 3s) overwrites the create
      // response's quote fields with `undefined`, and `pay-merchant.tsx`
      // throws `MISSING_QUOTE` the moment the user confirms after the first
      // poll lands.
      ...(() => {
        if (
          blockchain?.type !== "STELLAR" ||
          !this.stellarVerification ||
          !intent.sourceToken
        ) {
          return {};
        }
        const scale =
          10n ** BigInt(Math.max(intent.sourceToken.decimals - 6, 0));
        const signed = this.stellarVerification.buildMerchantQuoteSignature({
          blockchainId: blockchain.id,
          refId: intent.id,
          merchantId: intent.merchantId,
          tokenCompound: intent.sourceToken.contractAddress ?? "",
          amount: (intent.nanopayUsdcAmountMicros ?? 0n) * scale,
          platformFeeAmount: (intent.platformFeeAmountMinor ?? 0n) * scale,
          fiatAmountMinor: BigInt(intent.fiatAmountMinor),
          fiatCurrency: intent.fiatCurrency,
          exchangeRateId: BigInt(intent.exchangeRateId),
          expiresAt: BigInt(Math.floor(intent.expiresAt.getTime() / 1000)),
        });
        if (!signed) return {};
        return {
          quoteCommitmentStellar: signed.commitment,
          quoteSignatureStellar: signed.signatureBase64,
          backendSignerPubkeyStellar: signed.backendSignerPubkeyHex,
          takumiPayContractId: signed.contractId,
        };
      })(),
    };
  }

  /**
   * `POST /v1/pay/intents/:id/nanopay` — the Circle settle proxy (task 24,
   * spec §6.2 `NanopaySubmitRequest`, §6.5).
   *
   * Responsibilities:
   *   1. Load the intent. 404 if missing. 409 if already terminal
   *      (SETTLED/PAID_OUT/FAILED/EXPIRED) or pre-quote (shouldn't happen).
   *   2. Idempotency dedup by `(intentId, signature)`. Returns the existing
   *      submission row verbatim without re-calling Circle. Same signature
   *      ⇒ same Circle transaction id — Circle's nonce uniqueness guarantees
   *      replay safety on their side too.
   *   3. Build Circle's `/gateway/v1/x402/settle` body from the PERSISTED
   *      intent (NOT from the client's echo) — the only payer-sourced field
   *      is `signature`.
   *   4. Fire the request with a 30 s timeout:
   *        - 200 `success: true`  → SETTLED, persist `circleSettleTxUuid`,
   *                                  fire Xendit trigger (soft-linked),
   *                                  return `{ status: SETTLED }`.
   *        - 2xx/4xx `success: false` → FAILED, map errorReason, persist
   *                                     failureCode/Message, return
   *                                     `{ status: FAILED, failure }`.
   *        - 5xx / non-JSON / network → FAILED with CIRCLE_UPSTREAM_ERROR.
   *        - timeout (AbortError)     → SETTLING (in-flight, retry-safe).
   *                                      Row created with no circle tx yet;
   *                                      client polls the intent to converge.
   *
   * Three-role separation: every field Circle sees except `signature` comes
   * from the DB row the server wrote at quote time. Client `payload` echo
   * is ignored after a loose sanity-check — we never branch Circle's body
   * on untrusted input (memory `feedback_role_separation.md`).
   */
  async submitNanopay(args: {
    intentId: string;
    signature: `0x${string}`;
  }): Promise<NanopaySubmitResponseDto> {
    const { intentId, signature } = args;

    this.logger.log(`[submitNanopay] intentId=${intentId}`);

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { merchant: true, payer: true },
    });
    if (!intent) {
      throw new NotFoundException({
        message: `PaymentIntent ${intentId} not found.`,
        code: "PAYMENT_INTENT_NOT_FOUND",
      });
    }

    // Nanopay guard — these fields are always populated for nanopay intents.
    // Null means this intent was created for a different rail (e.g. onchain
    // settlement) and the caller shouldn't be hitting this endpoint.
    if (
      intent.nanopayUsdcAmountMicros === null ||
      intent.nanopayUsdcSourceChainId === null ||
      intent.nanopayUsdcTreasuryAddress === null
    ) {
      throw new BadRequestException({
        message: "Intent is not a nanopay intent.",
        code: "INTENT_NOT_NANOPAY",
      });
    }

    // Status gate. Spec: "SIGNED → SETTLED atomically" (task file §2
    // acceptance #4). The intent lifecycle in M2 is QUOTED → SETTLED (we
    // never stamp SIGNED because the mobile signs and submits in the same
    // round-trip). Accept BOTH so a future SIGNED-stage split doesn't
    // require this file to change.
    if (intent.status !== "QUOTED" && intent.status !== "SIGNED") {
      throw new ConflictException({
        message: `PaymentIntent ${intentId} is in status ${intent.status}; expected QUOTED or SIGNED.`,
        code: "INTENT_WRONG_STATUS",
        status: intent.status,
      });
    }

    // Idempotency — (intentId, signature) is the natural dedup key per user
    // scope §3 item 3. A retry with the same signature returns the existing
    // submission row without re-calling Circle (Circle's own nonce
    // uniqueness would reject anyway, but returning our prior answer is
    // cheaper AND stable for retry-safe clients).
    //
    // Prisma stores `signature` as Bytes — we search with a Uint8Array (not
    // Buffer) so the query plan matches `bytea =` in Postgres without a
    // subquery cast.
    const sigBytes = hexToBytes(signature);
    const existing = await this.prisma.nanopaySubmission.findFirst({
      where: { intentId, signature: sigBytes },
      orderBy: { submittedAt: "desc" },
    });
    if (existing) {
      return this.toSubmissionResponse(intentId, existing);
    }

    // x402 domain — needed for Circle's `paymentRequirements.network` and
    // `paymentRequirements.asset`. Null cache entry means the boot-time
    // fetch hasn't landed yet (or Circle dropped Arc). We can't build a
    // valid settle request without it — return 503 so mobile retries.
    const x402Entry = this.x402Supported.getSupportedForChain(
      intent.nanopayUsdcSourceChainId,
    );
    if (!x402Entry || !x402Entry.asset) {
      this.logger.error(
        `[submitNanopay] x402 domain not available for chainId=${intent.nanopayUsdcSourceChainId} — check CIRCLE_X402_SUPPORTED_URL and boot-time fetch`,
      );
      throw new ServiceUnavailableException({
        message: "Payment rail is not available on this deployment.",
        code: "X402_DOMAIN_UNAVAILABLE",
      });
    }

    // Assemble Circle's settle body. Every field (except the signature)
    // is rehydrated from the DB row the server itself wrote at quote time.
    // `from` MUST come off the payer join — the intent didn't persist it
    // separately (the quote path lowercases it into `payer.walletAddress`).
    // If the quote was created under the legacy `X-Payer-Address` header
    // path where `payerUserId` is null, fall back to "unknown" and let
    // Circle reject as `address_mismatch` (maps to SIGNATURE_INVALID).
    const fromAddress = (intent.payer?.walletAddress ?? "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(fromAddress)) {
      throw new ConflictException({
        message:
          "PaymentIntent has no bound payer wallet — cannot reconstruct the EIP-3009 `from` field.",
        code: "INTENT_NO_PAYER_ADDRESS",
      });
    }

    const nonceHex =
      `0x${Buffer.from(intent.nanopayNonce).toString("hex")}` as const;
    const valueMicros = intent.nanopayUsdcAmountMicros.toString();

    // `paymentPayload.payload.authorization` shape mirrors the x402 EVM
    // scheme Circle publishes. `network` is CAIP-2. We persist the
    // intent.nanopayUsdcSourceChainId as the source of truth and derive the
    // CAIP-2 string from the x402 entry so re-chain changes flow through
    // one place.
    const settleBody = {
      paymentPayload: {
        x402Version: 1,
        scheme: "exact",
        network: x402Entry.network,
        payload: {
          signature,
          authorization: {
            from: fromAddress,
            to: intent.nanopayUsdcTreasuryAddress.toLowerCase(),
            value: valueMicros,
            validAfter: intent.nanopayValidAfter.toString(),
            validBefore: intent.nanopayValidBefore.toString(),
            nonce: nonceHex,
          },
        },
      },
      paymentRequirements: {
        scheme: "exact",
        network: x402Entry.network,
        asset: x402Entry.asset,
        payTo: intent.nanopayUsdcTreasuryAddress.toLowerCase(),
        maxAmountRequired: valueMicros,
        maxTimeoutSeconds: intent.nanopayValidBefore - intent.nanopayValidAfter,
        resource: `takumipay://intent/${intent.id}`,
        description: `TakumiPay intent ${intent.id}`,
        mimeType: "application/json",
        // `extra` echoes the EIP-712 domain Circle expects — they use it
        // to re-derive the struct hash for verify.
        extra: {
          name: x402Entry.domainName,
          version: x402Entry.domainVersion,
        },
      },
    };

    const facilitatorUrl = await this.resolveFacilitatorUrl(
      intent.nanopayUsdcSourceChainId,
    );

    const submittedAt = new Date();
    this.logger.log(
      `[submitNanopay] calling Circle settle for intent=${intentId} usdcMicros=${valueMicros} from=${fromAddress} facilitatorUrl=${facilitatorUrl}`,
    );
    const outcome = await this.circleSettle.settle(facilitatorUrl, settleBody);
    this.logger.log(
      `[submitNanopay] Circle settle returned kind=${outcome.kind} for intent=${intentId}`,
    );

    return await this.persistOutcome({
      intent,
      signature: sigBytes,
      submittedAt,
      outcome,
    });
  }

  /**
   * `POST /v1/pay/intents/:id/nanopay-svm` — Solana x402 facilitator proxy
   * (task 43 / spec §5.2.1 Path B-SVM).
   *
   * The Solana equivalent of {@link submitNanopay}. Mobile's task-42 signer
   * produces a base64-encoded partially-signed Solana versioned transaction;
   * we forward the opaque string to the facilitator URL stored in
   * `Blockchain.x402FacilitatorUrl` for the SVM chain row.
   *
   * Three-role separation (memory `feedback_role_separation.md`): backend
   * does NOT parse the tx bytes — task-43 Constraints say "if
   * `@solana/web3.js` isn't in backend, skip parsing the signed tx on
   * backend; just forward the opaque base64 to Circle." We honor that here:
   * the signed blob is forwarded as-is, and the server-sourced fields
   * (paymentRequirements envelope) are rehydrated from the persisted intent.
   *
   * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
   * the gate is `isSvmChainId(intent.nanopayUsdcSourceChainId)` — a single
   * predicate. We do not branch on the preferredChain DTO or any string
   * comparison against "solana".
   *
   * Return shape matches the EVM submit endpoint (`NanopaySubmitResponseDto`)
   * so mobile receipt/polling code stays rail-agnostic.
   */
  async submitNanopaySvm(args: {
    intentId: string;
    signedTransaction: string;
  }): Promise<NanopaySubmitResponseDto> {
    const { intentId, signedTransaction } = args;

    this.logger.log(
      `[submitNanopaySvm] intentId=${intentId} txLen=${signedTransaction.length}`,
    );

    if (!this.circleSettleSvm) {
      // Pre-M6 posture — the client is `@Optional()` so the module boots
      // without it, and in that case the SVM rail is simply off.
      this.logger.error(
        "[submitNanopaySvm] circleSettleSvm client not injected — SVM_SETTLER_PRIVATE_KEY or facilitator URL likely missing",
      );
      throw new ServiceUnavailableException({
        message: "SVM payment rail is not available on this deployment.",
        code: "SVM_FACILITATOR_NOT_CONFIGURED",
      });
    }

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { merchant: true, payer: true },
    });
    if (!intent) {
      throw new NotFoundException({
        message: `PaymentIntent ${intentId} not found.`,
        code: "PAYMENT_INTENT_NOT_FOUND",
      });
    }

    // Nanopay guard — these fields are always populated for nanopay intents.
    if (
      intent.nanopayUsdcAmountMicros === null ||
      intent.nanopayUsdcSourceChainId === null ||
      intent.nanopayUsdcTreasuryAddress === null
    ) {
      throw new BadRequestException({
        message: "Intent is not a nanopay intent.",
        code: "INTENT_NOT_NANOPAY",
      });
    }

    // Chain-extension gate. An SVM-signed tx against an EVM intent is a
    // developer mistake worth surfacing loudly — 400, not 409, because the
    // endpoint is wrong, not the state.
    if (!isSvmChainId(intent.nanopayUsdcSourceChainId)) {
      throw new BadRequestException({
        message: `PaymentIntent ${intentId} is not a Solana intent (sourceChainId=${intent.nanopayUsdcSourceChainId}); use POST /nanopay instead.`,
        code: "INTENT_WRONG_CHAIN_NAMESPACE",
      });
    }

    if (intent.status !== "QUOTED" && intent.status !== "SIGNED") {
      throw new ConflictException({
        message: `PaymentIntent ${intentId} is in status ${intent.status}; expected QUOTED or SIGNED.`,
        code: "INTENT_WRONG_STATUS",
        status: intent.status,
      });
    }

    // Idempotency dedup by `(intentId, signedTransaction)`. We fingerprint
    // the base64 transaction as SHA-256 bytes so it fits in the existing
    // `NanopaySubmission.signature` column (Bytes) without a schema change.
    // Same hash → same row, returned verbatim without re-hitting the
    // facilitator (Solana rejects a duplicate tx anyway, but the short-
    // circuit is cheaper and retry-stable).
    const fingerprint = sha256Bytes(signedTransaction);
    const existing = await this.prisma.nanopaySubmission.findFirst({
      where: { intentId, signature: fingerprint },
      orderBy: { submittedAt: "desc" },
    });
    if (existing) {
      return this.toSubmissionResponse(intentId, existing);
    }

    // Confirm the SVM blockchain row is seeded + active before we ship to
    // the facilitator. This is a DB sanity check, not a namespace branch —
    // the predicate above already guaranteed SVM.
    const chainRow = await this.resolveSvmBlockchainRow(
      intent.nanopayUsdcSourceChainId,
    );
    if (!chainRow) {
      this.logger.error(
        `[submitNanopaySvm] SVM blockchain row missing for sentinel chainId=${intent.nanopayUsdcSourceChainId} — seed the Blockchain table`,
      );
      throw new ServiceUnavailableException({
        message: "SVM payment rail is not available on this deployment.",
        code: "SVM_CHAIN_NOT_CONFIGURED",
      });
    }

    if (!chainRow.x402FacilitatorUrl) {
      this.logger.error(
        `[submitNanopaySvm] x402FacilitatorUrl not set on Blockchain row chainSlug=${chainRow.chainSlug} — update the DB seed`,
      );
      throw new ServiceUnavailableException({
        message: "SVM payment rail is not available on this deployment.",
        code: "SVM_FACILITATOR_NOT_CONFIGURED",
      });
    }

    const x402Entry =
      this.x402Supported.getSupportedForNetwork(
        chainRow.chainSlug === "solana-mainnet"
          ? "solana:mainnet"
          : "solana:devnet",
      ) ??
      this.x402Supported.getSupportedForNetwork(
        chainRow.chainSlug === "solana-mainnet"
          ? "solana:mainnet-beta"
          : "solana:devnet",
      );

    // Build the paymentRequirements envelope purely from persisted data —
    // mobile's echo is explicitly ignored (three-role separation). The
    // facilitator may or may not use every field (Circle does; some
    // external facilitators treat the tx as self-describing) — we send it
    // on every call because the overhead is a few hundred bytes.
    const payTo = intent.nanopayUsdcTreasuryAddress;
    const usdcMint =
      x402Entry?.asset ?? (await this.resolveSvmUsdcMint(chainRow.id));

    const paymentRequirements = {
      scheme: "exact",
      network:
        x402Entry?.network ??
        (chainRow.chainSlug === "solana-mainnet"
          ? "solana:mainnet"
          : "solana:devnet"),
      asset: usdcMint,
      payTo,
      amount: intent.nanopayUsdcAmountMicros.toString(),
      maxTimeoutSeconds: 60,
      resource: `takumipay://intent/${intent.id}`,
      description: `TakumiPay intent ${intent.id}`,
      mimeType: "application/json",
      extra: {
        feePayer: x402Entry?.authorizedSigners?.[0],
      },
    };

    const submittedAt = new Date();
    this.logger.log(
      `[submitNanopaySvm] calling SVM facilitator for intent=${intentId} usdcMicros=${intent.nanopayUsdcAmountMicros?.toString()} facilitatorUrl=${chainRow.x402FacilitatorUrl}`,
    );
    const outcome = await this.circleSettleSvm.settle(
      chainRow.x402FacilitatorUrl,
      { signedTransaction, paymentRequirements },
    );
    this.logger.log(
      `[submitNanopaySvm] SVM facilitator returned kind=${outcome.kind} for intent=${intentId}`,
    );

    return await this.persistSvmOutcome({
      intent,
      fingerprint,
      submittedAt,
      outcome,
    });
  }

  /**
   * `POST /v1/pay/intents/:id/onchain` — on-chain settlement submit.
   *
   * The client hands us the tx hash the moment its wallet has broadcast
   * the `takumi_pay` payment. Everything that needs the chain — waiting
   * for the receipt at the chain's confirmation depth, reading the
   * contract record, deciding — runs on the `onchain-settlement` queue
   * (`OnchainSettlementProcessor`), not in this request. This handler
   * only records the hash, moves the intent to SIGNED (out of the
   * expiry sweeper's reach), creates the PENDING activity row the user
   * can watch from Activity, and enqueues. It returns `SETTLING`
   * immediately; the client polls / gets a push.
   *
   * Why not verify inline: verification legitimately takes seconds
   * (receipt + confirmations) and, on a bad day, minutes or hours (RPC
   * outage). Holding the user's request for that — and reporting a
   * verdict that is really "our side is down" — is what stranded two
   * real Monad Testnet payments on 2026-09-17. The user's part of the
   * job is done when the tx is out; ours can take as long as it takes.
   *
   * Idempotency: (intentId, txHash) is unique. A hash already VERIFIED
   * returns SETTLED with its attestation. A hash still in flight (or one
   * whose last attempt was transient) returns SETTLING without
   * enqueueing a duplicate job (BullMQ job id = intentId:txHash).
   */
  async submitOnchain(args: {
    intentId: string;
    txHash: string;
    blockchainId: string;
  }): Promise<NanopaySubmitResponseDto> {
    const { intentId, txHash, blockchainId } = args;

    this.logger.log(
      `[submitOnchain] intentId=${intentId} txHash=${txHash} blockchainId=${blockchainId}`,
    );

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { merchant: true, payer: true },
    });
    if (!intent) {
      throw new NotFoundException({
        message: `PaymentIntent ${intentId} not found.`,
        code: "PAYMENT_INTENT_NOT_FOUND",
      });
    }

    const existing = await this.prisma.onchainSettlement.findFirst({
      where: { intentId, txHash },
    });
    if (existing?.verifiedAt) {
      return {
        status: "SETTLED",
        intentId,
        attestation: {
          id: existing.id,
          receivedAt: existing.verifiedAt.getTime(),
        },
      };
    }

    if (intent.status !== "QUOTED" && intent.status !== "SIGNED") {
      throw new ConflictException({
        message: `PaymentIntent ${intentId} is in status ${intent.status}; expected QUOTED or SIGNED.`,
        code: "INTENT_WRONG_STATUS",
        status: intent.status,
      });
    }

    const blockchain = await this.prisma.blockchain.findUnique({
      where: { id: blockchainId },
    });
    if (!blockchain) {
      throw new BadRequestException({
        message: `Blockchain ${blockchainId} not found.`,
        code: "ONCHAIN_BLOCKCHAIN_NOT_FOUND",
      });
    }

    // Cheap config checks up front so a misconfigured chain fails the
    // request loudly instead of a job silently retrying for a day.
    if (blockchain.type === "EVM") {
      if (blockchain.chainId == null) {
        throw new BadRequestException({
          message: `Blockchain ${blockchain.name} is missing chainId`,
          code: "ONCHAIN_BLOCKCHAIN_MISCONFIGURED",
        });
      }
      const contract = await this.prisma.smartContract.findFirst({
        where: { blockchainId, name: "takumi_pay", isActive: true },
        select: { id: true },
      });
      if (!contract) {
        throw new BadRequestException({
          message: `Blockchain ${blockchain.name} has no active "takumi_pay" SmartContract row configured`,
          code: "ONCHAIN_CONTRACT_NOT_FOUND",
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.onchainSettlement.upsert({
        where: { intentId_txHash: { intentId, txHash } },
        create: {
          intentId,
          txHash,
          chainId: blockchain.chainId,
          cluster: blockchain.solanaCluster,
        },
        update: {},
      });
      // Out of the expiry sweeper's reach: the quote may lapse while the
      // chain is slow, but the payment is already out.
      await tx.paymentIntent.updateMany({
        where: { id: intentId, status: "QUOTED" },
        data: { status: "SIGNED" },
      });
    });

    await this.ensureMerchantPaymentActivity(intent, txHash);

    await this.enqueueSettlementVerification({
      intentId,
      txHash,
      blockchainId,
    });

    return { status: "SETTLING", intentId, attestation: null };
  }

  /**
   * Adds the verification job, deduplicated on (intentId, txHash). A job
   * that already finished (completed or exhausted) is removed first so a
   * client re-submit after e.g. a NEEDS_REVIEW verdict re-runs
   * verification instead of being silently ignored.
   */
  private async enqueueSettlementVerification(
    data: OnchainSettlementJobData,
  ): Promise<void> {
    if (!this.onchainSettlementQueue) {
      this.logger.error(
        `[submitOnchain] no settlement queue bound; intent=${data.intentId} txHash=${data.txHash} will not be verified until one is`,
      );
      return;
    }
    const jobId = `${data.intentId}:${data.txHash}`;
    const prior = await this.onchainSettlementQueue.getJob(jobId);
    if (prior) {
      const state = await prior.getState();
      if (state === "completed" || state === "failed") {
        await prior.remove();
      } else {
        this.logger.log(
          `[submitOnchain] verification already ${state} for ${jobId}; not enqueueing again`,
        );
        return;
      }
    }
    await this.onchainSettlementQueue.add(ONCHAIN_SETTLEMENT_JOB, data, {
      ...SETTLEMENT_JOB_OPTIONS,
      jobId,
    });
  }

  /**
   * Phase A + B against the chain for one submitted hash. Throws on any
   * failure; the caller classifies (`classifySettlementError`). Returns
   * the payer the chain recorded.
   *
   *   A. `verifyMerchantPaymentTx` (EVM) — receipt at the chain's own
   *      confirmation depth, success, `takumi_pay` recipient, and the
   *      `MerchantPaymentProcessed` log that binds the tx to THIS intent
   *      and names the wallet that really paid (a user may pay from any
   *      linked wallet, so `intent.payer.walletAddress` is not reliable).
   *   B. `verifyMerchantPaymentInContract` — the contract's record for
   *      this refId matched against the backend-signed quote. Stellar and
   *      Solana dispatch inside it (Solana waits for the signature to
   *      confirm first).
   */
  async verifyOnchainPayment(args: {
    intent: {
      id: string;
      merchantId: string;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      exchangeRateId: number;
    };
    blockchain: {
      id: string;
      name: string;
      type: string;
      chainId: number | null;
      minConfirmations: number | null;
    };
    txHash: string;
  }): Promise<{ payer: string }> {
    const { intent, blockchain, txHash } = args;
    if (!this.blockchainVerification) {
      throw new Error("BlockchainVerificationService is not available");
    }

    const token = intent.sourceTokenId
      ? await this.prisma.token.findUnique({
          where: { id: intent.sourceTokenId },
        })
      : null;
    const scale = 10n ** BigInt(Math.max((token?.decimals ?? 6) - 6, 0));
    const expectedAmount = (
      BigInt(String(intent.nanopayUsdcAmountMicros ?? 0n)) * scale
    ).toString();

    let contractAddress = "";
    let chainId = 0;
    let expectedPayer = "";
    if (blockchain.type === "EVM") {
      if (blockchain.chainId == null) {
        throw new BadRequestException(
          `Blockchain ${blockchain.name} is missing chainId`,
        );
      }
      chainId = blockchain.chainId;
      const contract = await this.prisma.smartContract.findFirst({
        where: {
          blockchainId: blockchain.id,
          name: "takumi_pay",
          isActive: true,
        },
      });
      if (!contract) {
        throw new BadRequestException(
          `Blockchain ${blockchain.name} has no active "takumi_pay" SmartContract row configured`,
        );
      }
      contractAddress = contract.address;

      const phaseA = await this.blockchainVerification.verifyMerchantPaymentTx({
        txHash,
        chainId,
        contractAddress,
        refId: intent.id,
        minimumConfirmations: resolveMinConfirmations(blockchain, this.config),
      });
      expectedPayer = phaseA.payer;
      this.logger.log(
        `[verifyOnchainPayment] phase A ok intent=${intent.id} txHash=${txHash} payer=${expectedPayer} confirmations=${phaseA.confirmations}`,
      );
    }

    await this.blockchainVerification.verifyMerchantPaymentInContract({
      contractAddress, // unused in the Stellar/Solana dispatch branches
      chainId, // unused in the Stellar/Solana dispatch branches
      refId: intent.id,
      expectedPayer,
      expectedMerchantId: intent.merchantId,
      expectedTokenAddress: token?.contractAddress ?? "",
      expectedAmount,
      expectedFiatAmountMinor: intent.fiatAmountMinor,
      expectedFiatCurrency: intent.fiatCurrency,
      expectedExchangeRateId: intent.exchangeRateId,
      blockchainId: blockchain.id,
      txHash,
    });

    return { payer: expectedPayer };
  }

  /**
   * Verification passed: persist, flip the intent, and fan out — payout
   * trigger, activity row → COMPLETED, "Payment sent" push. Returns
   * `false` when a concurrent run already did the flip (guarded
   * `updateMany` on QUOTED/SIGNED), in which case nothing is re-fired:
   * a hash replayed N times can only pay a merchant once.
   */
  async finalizeOnchainSettlement(args: {
    intent: {
      id: string;
      payerUserId: string | null;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      merchant: { displayName: string };
      payer: { walletAddress: string | null } | null;
      nanopayUsdcTreasuryAddress: string | null;
    };
    blockchain: { chainId: number | null; solanaCluster: string | null };
    txHash: string;
  }): Promise<boolean> {
    const { intent, blockchain, txHash } = args;
    const intentId = intent.id;

    const settledNow = await this.prisma.$transaction(async (tx) => {
      await tx.onchainSettlement.upsert({
        where: { intentId_txHash: { intentId, txHash } },
        create: {
          intentId,
          txHash,
          chainId: blockchain.chainId,
          cluster: blockchain.solanaCluster,
          verifiedAt: new Date(),
        },
        update: {
          verifiedAt: new Date(),
          failureCode: null,
          failureMessage: null,
        },
      });
      const flipped = await tx.paymentIntent.updateMany({
        where: { id: intentId, status: { in: ["QUOTED", "SIGNED"] } },
        data: { status: "SETTLED" },
      });
      return flipped.count === 1;
    });

    if (!settledNow) {
      this.logger.log(
        `[finalizeOnchainSettlement] intent=${intentId} already settled by a concurrent run of txHash=${txHash}; not re-triggering payout`,
      );
      return false;
    }

    this.logger.log(
      `[finalizeOnchainSettlement] intent=${intentId} SETTLED txHash=${txHash}`,
    );

    if (this.payoutProvider) {
      Promise.resolve(this.payoutProvider.trigger(intentId)).catch((err) => {
        this.logger.error(
          `Payout trigger failed for intent=${intentId}: ${err?.message}`,
          err?.stack,
        );
      });
    }

    await this.ensureMerchantPaymentActivity(intent, txHash);
    await this.setMerchantPaymentActivityStatus(intentId, "COMPLETED");

    if (this.pushService) {
      await this.pushService.sendSettledPush(intentId).catch((err) => {
        this.logger.warn(
          `[finalizeOnchainSettlement] settled push failed intent=${intentId}: ${(err as Error)?.message}`,
        );
      });
    }

    return true;
  }

  /**
   * A chain verdict that is not "verified", or a retry budget spent.
   *
   *   rejected_reverted → nothing moved. Intent FAILED, activity FAILED,
   *                       push "didn't go through, you weren't charged".
   *   rejected_mismatch → mined but not the quoted payment. Intent stays
   *   transient (spent)   SIGNED, row flagged NEEDS_REVIEW for ops,
   *                       activity stays PENDING, push "we're checking".
   *
   * Never called for a transient failure that still has retries left —
   * those are recorded with `recordOnchainAttempt` and stay silent.
   */
  async markOnchainSettlementIssue(args: {
    intentId: string;
    txHash: string;
    blockchain: { chainId: number | null; solanaCluster: string | null };
    outcome: SettlementOutcome;
    message: string;
  }): Promise<void> {
    const { intentId, txHash, blockchain, outcome, message } = args;
    const reverted = outcome === "rejected_reverted";

    await this.recordOnchainAttempt({
      intentId,
      txHash,
      blockchain,
      failureCode: reverted ? TX_REVERTED : NEEDS_REVIEW,
      failureMessage: message,
    });

    if (reverted) {
      const flipped = await this.prisma.paymentIntent.updateMany({
        where: { id: intentId, status: { in: ["QUOTED", "SIGNED"] } },
        data: { status: "FAILED" },
      });
      if (flipped.count === 0) {
        // Settled or failed by another path meanwhile; nothing to tell.
        return;
      }
    }

    const activityId = await this.setMerchantPaymentActivityStatus(
      intentId,
      reverted ? "FAILED" : "PENDING",
    );

    if (this.pushService) {
      await this.pushService
        .sendSettlementIssuePush(
          intentId,
          reverted ? "reverted" : "needs_review",
          activityId ?? undefined,
        )
        .catch((err) => {
          this.logger.warn(
            `[markOnchainSettlementIssue] push failed intent=${intentId}: ${(err as Error)?.message}`,
          );
        });
    }
  }

  /** Audit row for an attempt that did not verify; safe to re-run. */
  async recordOnchainAttempt(args: {
    intentId: string;
    txHash: string;
    blockchain: { chainId: number | null; solanaCluster: string | null };
    failureCode: string;
    failureMessage: string;
  }): Promise<void> {
    const { intentId, txHash, blockchain, failureCode } = args;
    const failureMessage = args.failureMessage.slice(0, 1000);
    try {
      await this.prisma.onchainSettlement.upsert({
        where: { intentId_txHash: { intentId, txHash } },
        create: {
          intentId,
          txHash,
          chainId: blockchain.chainId,
          cluster: blockchain.solanaCluster,
          failureCode,
          failureMessage,
        },
        update: { failureCode, failureMessage },
      });
    } catch (err) {
      this.logger.error(
        `[submitOnchain] could not record attempt intent=${intentId} txHash=${txHash}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * The Activity row for a merchant payment exists from the moment the
   * hash is submitted, as PENDING — so a user who leaves the pay screen
   * can watch it from Activity — and is flipped by the verifier. One row
   * per intent (`paymentIntentId`); re-runs are no-ops.
   */
  private async ensureMerchantPaymentActivity(
    intent: {
      id: string;
      payerUserId: string | null;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      merchant: { displayName: string };
      payer: { walletAddress: string | null } | null;
      nanopayUsdcTreasuryAddress: string | null;
    },
    txHash: string,
  ): Promise<void> {
    const existing = await this.prisma.transactionHistory.findFirst({
      where: { paymentIntentId: intent.id },
      select: { id: true },
    });
    if (existing) return;
    await this.recordMerchantPayment(intent, txHash, "PENDING");
  }

  /** Returns the activity row id, or null if none was recorded. */
  private async setMerchantPaymentActivityStatus(
    intentId: string,
    status: "PENDING" | "COMPLETED" | "FAILED",
  ): Promise<string | null> {
    const row = await this.prisma.transactionHistory.findFirst({
      where: { paymentIntentId: intentId },
      select: { id: true, createdAt: true, status: true },
    });
    if (!row) return null;
    if (row.status !== status) {
      await this.prisma.transactionHistory.update({
        where: { id_createdAt: { id: row.id, createdAt: row.createdAt } },
        data: { status: status as TransactionStatus },
      });
    }
    return row.id;
  }

  /**
   * Resolve the USDC SPL mint address for a given Solana blockchain row.
   * Reads from the Token table (symbol=USDC, isStablecoin, peggedCurrency=USD).
   * Falls back to the mainnet constant only if the DB lookup fails.
   */
  private async resolveSvmUsdcMint(blockchainId: string): Promise<string> {
    const token = await this.prisma.token.findFirst({
      where: {
        blockchainId,
        symbol: "USDC",
        isStablecoin: true,
        isActive: true,
      },
      select: { contractAddress: true },
    });
    return token?.contractAddress ?? USDC_SPL_MINT_MAINNET_FALLBACK;
  }

  /**
   * Resolve a Solana `Blockchain` row by sentinel chainId (task 43). Returns
   * `null` if the row isn't seeded or is inactive. Uses `chainSlug` because
   * Solana rows have `chainId = null` in the chain-agnostic schema
   * (migration 20260417000001).
   */
  private async resolveSvmBlockchainRow(sentinelChainId: number): Promise<{
    id: string;
    chainSlug: string;
    x402FacilitatorUrl: string | null;
  } | null> {
    const slug = SVM_SENTINEL_TO_CHAIN_SLUG[sentinelChainId];
    if (!slug) return null;
    const row = await this.blockchainCache.getByChainSlug(slug, () =>
      this.prisma.blockchain.findUnique({
        where: { chainSlug: slug },
        select: {
          id: true,
          chainSlug: true,
          isActive: true,
          type: true,
          metadata: true,
        },
      }),
    );
    if (!row || !row.isActive || row.type === "EVM") return null;
    return {
      id: row.id,
      chainSlug: row.chainSlug ?? slug,
      x402FacilitatorUrl:
        (row.metadata as { x402FacilitatorUrl?: string } | null)
          ?.x402FacilitatorUrl ?? null,
    };
  }

  /**
   * SVM equivalent of {@link persistOutcome}. Same four-branch state machine
   * (`ok` / `rejected` / `upstream` / `timeout`) so the wire shape stays
   * symmetric with the EVM rail.
   */
  private async persistSvmOutcome(args: {
    intent: {
      id: string;
      status: PaymentIntentStatus;
      payerUserId: string | null;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      nanopayUsdcTreasuryAddress: string | null;
      merchant: { displayName: string };
      payer: { walletAddress: string | null } | null;
    };
    fingerprint: Uint8Array;
    submittedAt: Date;
    outcome: CircleSettleSvmOutcome;
  }): Promise<NanopaySubmitResponseDto> {
    const { intent, fingerprint, submittedAt, outcome } = args;

    if (outcome.kind === "ok") {
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature: fingerprint,
            submittedAt,
            // SVM returns a Solana signature (base58), not a UUID. We stash
            // it in `circleSettleTxUuid` for audit continuity and accept
            // that the column name is EVM-flavored — the alternative is a
            // schema migration that's not warranted for the M6 cut. The
            // field is treated as "facilitator-assigned tx id" at read time.
            circleSettleTxUuid: outcome.response.transaction,
            circleSettleResponseReceivedAt: submittedAt,
            circleSettleNetwork: outcome.response.network,
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "SETTLED" },
        });
        return created;
      });

      this.kickPayout(intent.id);
      this.recordMerchantPayment(intent);
      return this.toSubmissionResponse(intent.id, submission);
    }

    if (outcome.kind === "rejected") {
      const { code, message } = mapCircleErrorReason(
        outcome.response.errorReason,
        outcome.response.message,
      );
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature: fingerprint,
            submittedAt,
            circleSettleResponseReceivedAt: submittedAt,
            circleSettleNetwork: outcome.response.network ?? null,
            failureCode: code,
            failureMessage: outcome.response.errorReason ?? message,
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED" },
        });
        return created;
      });
      this.logger.warn(
        `SVM settle rejected for intent=${intent.id} code=${code} status=${outcome.status}`,
      );
      return this.toSubmissionResponse(intent.id, submission);
    }

    if (outcome.kind === "upstream") {
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature: fingerprint,
            submittedAt,
            circleSettleResponseReceivedAt: submittedAt,
            failureCode: "CIRCLE_UPSTREAM_ERROR",
            failureMessage: truncateMessage(outcome.message),
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED" },
        });
        return created;
      });
      this.logger.error(
        `SVM settle upstream error for intent=${intent.id} status=${outcome.status ?? "n/a"}`,
      );
      return this.toSubmissionResponse(intent.id, submission);
    }

    // timeout — same retry-safe posture as EVM: mark in-flight (SIGNED in
    // schema; SETTLING on the wire) so mobile keeps polling instead of
    // treating the tx as failed.
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.nanopaySubmission.create({
        data: {
          intentId: intent.id,
          signature: fingerprint,
          submittedAt,
          failureCode: null,
          failureMessage: truncateMessage(outcome.message),
        },
      });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "SIGNED" },
      });
      return created;
    });
    this.logger.warn(
      `SVM settle timed out for intent=${intent.id}; marked in-flight (SETTLING).`,
    );
    return {
      intentId: intent.id,
      status: "SETTLING",
      attestation: null,
      failure: null,
    };
  }

  /**
   * `POST /v1/pay/intents/:id/deposit-receipt` — task 38, spec §6.2
   * `DepositReceiptRequest` / `DepositReceiptResponse` and §6.6
   * `gateway_deposits`.
   *
   * The onboarding flow (task 34) submits a USDC deposit UserOp into
   * Circle GatewayWallet (task 35 + task 37) and, once the source-chain
   * tx confirms, POSTs here so the server records the deposit in its
   * audit table and — if Circle's ledger has already attested — flips
   * the associated intent's `requiresDeposit` to `false` so the Nanopay
   * settle path unblocks.
   *
   * Responsibilities:
   *   1. Auth: payer-only. Unrelated users → 403.
   *   2. Cross-check the intent's `nanopayUsdcSourceChainId` against the body's
   *      `chainId`, and the intent's `nanopayUsdcAmountMicros` against the
   *      body's `amountMicros` (task prompt §Rules — don't trust client
   *      claims; the amount is a load-bearing field on the audit row).
   *   3. On-chain verification: pull the receipt + tx via the
   *      {@link BlockchainVerificationService} public client. We check
   *      three things and only three — status=success, tx.from matches
   *      the payer, tx.to matches the chain's Gateway wallet contract.
   *      Bundler-included UserOp txs bill gas from the bundler EOA (not
   *      the payer), so we DO trust the `from` field of the top-level tx
   *      to name the bundler when `usedCirclePaymaster=true`; in that
   *      case we skip the `from` check and leave a TODO. The deposit is
   *      still verifiable by the `to` being GatewayWallet (a contract the
   *      attacker can't spoof) + the audited status=success.
   *   4. Persist a `GatewayDeposit` row. `txHash` is unique (migration
   *      20260420234642) so replays land on a 409-from-DB that we catch
   *      and translate into a 200 echo of the existing row — task prompt
   *      §3 idempotency contract.
   *   5. If Circle's `/v1/deposits` attestation endpoint is wired (task
   *      38 spec §6.5 — not in this scope), CONFIRMED is set when the
   *      ledger reports the deposit. For the M4 shipping cut we mark the
   *      row CONFIRMED immediately once on-chain verification passes;
   *      the Circle-side attestation wait is a follow-up (see TODO in
   *      method body). The DB is the audit trail; a subsequent attestation
   *      poller can relax CONFIRMED back to PENDING_ATTESTATION only by
   *      adding the poller — we never regress forward.
   *   6. Flip `PaymentIntent.requiresDeposit = false` iff the intent is
   *      still QUOTED and currently has `requiresDeposit=true`. We do NOT
   *      mutate `status` — the spec explicitly models the deposit as a
   *      prerequisite to the settle, not a settle milestone (§6.3). The
   *      intent stays QUOTED until `POST /nanopay` flips it to SETTLED.
   *
   * Three-role separation (memory `feedback_role_separation.md`): every
   * field Circle / the chain sees is derived from the persisted row or
   * the on-chain lookup. The client only supplies `txHash`,
   * `usedCirclePaymaster`, and echoed `chainId`/`amountMicros` which we
   * cross-check before trusting.
   */
  async recordDepositReceipt(args: {
    intentId: string;
    txHash: `0x${string}`;
    chainId: number;
    amountMicros: string;
    usedCirclePaymaster: boolean;
    callerUserId: string | null;
    callerWalletAddress: string | null;
  }): Promise<DepositReceiptResponseDto> {
    const {
      intentId,
      txHash,
      chainId,
      amountMicros,
      usedCirclePaymaster,
      callerUserId,
      callerWalletAddress,
    } = args;

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { payer: true },
    });
    if (!intent) {
      throw new NotFoundException({
        message: `PaymentIntent ${intentId} not found.`,
        code: "PAYMENT_INTENT_NOT_FOUND",
      });
    }

    // Payer-only auth. Mirrors the `isPayerByUserId` / `isPayerByAddress`
    // branches in `getIntent`, except we deliberately do NOT accept the
    // merchant owner here — the deposit belongs to the payer, and the
    // merchant has no legitimate reason to ack a payer's deposit.
    const normalizedCallerAddr = callerWalletAddress?.toLowerCase() ?? null;
    const payerAddr = intent.payer?.walletAddress?.toLowerCase() ?? null;
    const isPayerByUserId =
      !!callerUserId &&
      !!intent.payerUserId &&
      callerUserId === intent.payerUserId;
    const isPayerByAddress =
      !!normalizedCallerAddr &&
      !!payerAddr &&
      normalizedCallerAddr === payerAddr;
    if (!isPayerByUserId && !isPayerByAddress) {
      throw new ForbiddenException({
        message: "Only the intent's payer can submit a deposit receipt.",
        code: "DEPOSIT_RECEIPT_FORBIDDEN",
      });
    }

    // Nanopay guard — deposit receipts are only relevant for nanopay intents
    // that carry Circle USDC fields.
    if (
      intent.nanopayUsdcAmountMicros === null ||
      intent.nanopayUsdcSourceChainId === null
    ) {
      throw new BadRequestException({
        message: "Intent is not a nanopay intent.",
        code: "INTENT_NOT_NANOPAY",
      });
    }

    // Cross-check echoed fields against the persisted intent before we
    // spend an RPC call verifying. A client that sends the wrong chainId
    // or wrong amount is either broken or malicious — 400 fast.
    if (chainId !== intent.nanopayUsdcSourceChainId) {
      throw new BadRequestException({
        message: `chainId ${chainId} does not match intent source chain ${intent.nanopayUsdcSourceChainId}.`,
        code: "DEPOSIT_CHAIN_MISMATCH",
      });
    }
    if (amountMicros !== intent.nanopayUsdcAmountMicros.toString()) {
      throw new BadRequestException({
        message: `amountMicros ${amountMicros} does not match intent amount ${intent.nanopayUsdcAmountMicros.toString()}.`,
        code: "DEPOSIT_AMOUNT_MISMATCH",
      });
    }

    // Idempotency precheck — avoid doing on-chain work (and a noisy DB
    // insert-fail-retry) if we've already persisted this txHash. The DB
    // unique constraint is still the authoritative dedup gate (handles
    // the concurrent-insert race); this is just the cheap path.
    const priorByHash = await this.prisma.gatewayDeposit.findUnique({
      where: { txHash },
    });
    if (priorByHash) {
      if (priorByHash.userId !== (intent.payerUserId ?? "")) {
        // Same txHash recorded for a different user — either a client
        // mix-up or a replay. 409 because the row exists and cannot be
        // re-assigned; the client should re-check what they submitted.
        throw new ConflictException({
          message:
            "Deposit txHash is already recorded against a different user.",
          code: "DEPOSIT_RECEIPT_OWNER_MISMATCH",
        });
      }
      return {
        depositId: priorByHash.id,
        status: priorByHash.status as GatewayDepositStatus,
      };
    }

    // On-chain verification. We fetch the tx + receipt via the cached
    // public client. The check is intentionally narrow (task prompt §3
    // item 3): status=success, to=GatewayWallet, and — when the payer
    // paid gas themselves — from=payer. For paymaster-sponsored UserOps
    // the top-level tx.from is the bundler EOA, so the `from` identity
    // check has to defer to Circle's ledger (out-of-scope for task 38).
    const gatewayWalletContract =
      await this.resolveGatewayWalletContract(chainId);
    const verification = await this.verifyDepositTx({
      txHash,
      chainId,
      expectedFrom: payerAddr ?? null,
      expectedTo: gatewayWalletContract,
      skipFromCheck: usedCirclePaymaster,
    });
    if (!verification.ok) {
      // Task prompt §Rules: "tx verification failure → 400 (or accept +
      // warn)". We 400 to keep the mobile state model crisp — a genuinely
      // dropped tx surfaces `DEPOSIT_FAILED` and the user retries. If the
      // chain is slow and we can't retrieve the receipt in time, the
      // mobile client will retry the POST and we'll converge on success.
      throw new BadRequestException({
        message: verification.reason,
        code: "DEPOSIT_TX_INVALID",
      });
    }

    // Persist the row. `status = CONFIRMED` once on-chain verification
    // passes — see the method-level docstring for why we don't gate on
    // Circle's `/v1/deposits` here. `confirmedAt = now` on CONFIRMED so
    // a future reconciliation script can tell "when did ops attest this"
    // apart from `createdAt = when the POST landed".
    //
    // TODO(task-38 Circle attestation): add a poller on
    // `POST /v1/deposits` (spec §6.5) that relaxes CONFIRMED → FAILED
    // when the ledger reports tx_failed, and refine the CONFIRMED flip
    // to wait for the ledger attestation. For M4 the on-chain receipt
    // is the authoritative signal because Gateway's ledger trails the
    // chain by <500 ms.
    const nowMs = Date.now();
    let created: { id: string; status: GatewayDepositStatus };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.gatewayDeposit.create({
          data: {
            userId: intent.payerUserId ?? "",
            sourceChainId: chainId,
            txHash,
            amountMicros: BigInt(amountMicros),
            usedCirclePaymaster,
            status: "CONFIRMED",
            confirmedAt: new Date(nowMs),
          },
        });
        // Flip `requiresDeposit` iff the intent is still QUOTED with
        // the flag set. Spec §6.3: deposit is a prerequisite, not a
        // settle milestone — DO NOT touch `status`.
        if (intent.status === "QUOTED" && intent.requiresDeposit) {
          await tx.paymentIntent.update({
            where: { id: intent.id },
            data: { requiresDeposit: false },
          });
        }
        return { id: row.id, status: row.status as GatewayDepositStatus };
      });
    } catch (err: unknown) {
      // Concurrent-insert race: another request persisted the same
      // txHash between our precheck and this insert. Treat as idempotent
      // success — re-read the row and echo it.
      if (isPrismaUniqueConstraintError(err)) {
        const existing = await this.prisma.gatewayDeposit.findUnique({
          where: { txHash },
        });
        if (!existing) {
          // Shouldn't happen — a P2002 means the unique index saw a row.
          // If Prisma and the DB disagree, prefer 500 over a silent lie.
          throw err;
        }
        return {
          depositId: existing.id,
          status: existing.status as GatewayDepositStatus,
        };
      }
      throw err;
    }

    return { depositId: created.id, status: created.status };
  }

  /**
   * Resolve the Gateway wallet contract address for a chain from the
   * seeded `Blockchain` row (§7.1). Throws `ServiceUnavailableException`
   * if the chain isn't configured — task 20 / ops seed populates this.
   */
  private async resolveGatewayWalletContract(chainId: number): Promise<string> {
    const row = await this.blockchainCache.getByChainId(chainId, () =>
      this.prisma.blockchain.findUnique({
        where: { chainId },
        select: { id: true, isActive: true },
      }),
    );
    if (!row || !row.isActive) {
      this.logger.error(
        `[resolveGatewayWalletContract] chainId=${chainId} not found or inactive in Blockchain table`,
      );
      throw new ServiceUnavailableException({
        message: "Payment rail is not available on this deployment.",
        code: "CHAIN_NOT_CONFIGURED",
      });
    }
    // Lives in SmartContract (name: "gateway_wallet"), not a scalar column —
    // see the schema comment on Blockchain.metadata.
    const contract = await this.prisma.smartContract.findFirst({
      where: { blockchainId: row.id, name: "gateway_wallet", isActive: true },
    });
    if (!contract) {
      this.logger.error(
        `[resolveGatewayWalletContract] no active "gateway_wallet" SmartContract row for chainId=${chainId} — update DB seed`,
      );
      throw new ServiceUnavailableException({
        message: "Payment rail is not available on this deployment.",
        code: "GATEWAY_WALLET_NOT_CONFIGURED",
      });
    }
    return contract.address;
  }

  private async resolveFacilitatorUrl(chainId: number): Promise<string> {
    const row = await this.blockchainCache.getByChainId(chainId, () =>
      this.prisma.blockchain.findUnique({
        where: { chainId },
        select: { metadata: true, isActive: true },
      }),
    );
    if (!row || !row.isActive) {
      this.logger.error(
        `[resolveFacilitatorUrl] chainId=${chainId} not found or inactive in Blockchain table`,
      );
      throw new ServiceUnavailableException({
        message: "Payment rail is not available on this deployment.",
        code: "CHAIN_NOT_CONFIGURED",
      });
    }
    const facilitatorUrl = (
      row.metadata as { x402FacilitatorUrl?: string } | null
    )?.x402FacilitatorUrl;
    if (!facilitatorUrl) {
      this.logger.error(
        `[resolveFacilitatorUrl] x402FacilitatorUrl not set in metadata for chainId=${chainId} — update DB seed`,
      );
      throw new ServiceUnavailableException({
        message: "Payment rail is not available on this deployment.",
        code: "FACILITATOR_URL_NOT_CONFIGURED",
      });
    }
    return facilitatorUrl;
  }

  /**
   * Lightweight on-chain verification for a Gateway deposit tx. Narrower
   * than {@link BlockchainVerificationService#verifyTransaction} because
   * task 38 doesn't need contract-state matching — just receipt success,
   * the right recipient, and (for non-paymaster txs) the right sender.
   *
   * Graceful degradation: if `BlockchainVerificationService` is unwired
   * (unit tests) or the RPC call fails transiently, we return an `ok`
   * result with a TODO in logs so the deposit is still recorded. The
   * task prompt §Rules permits falling back to trusting the client when
   * the bundler-included tx can't be reliably verified; the DB audit
   * (unique txHash + `usedCirclePaymaster` flag) preserves traceability.
   */
  private async verifyDepositTx(args: {
    txHash: `0x${string}`;
    chainId: number;
    expectedFrom: string | null;
    expectedTo: string;
    skipFromCheck: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { txHash, chainId, expectedFrom, expectedTo, skipFromCheck } = args;

    if (!this.blockchainVerification) {
      this.logger.warn(
        `BlockchainVerificationService not wired; trusting txHash=${txHash.slice(0, 10)}… (TODO: wire RPC client).`,
      );
      return { ok: true };
    }

    try {
      const client = this.blockchainVerification.getPublicClient(chainId);
      const receipt = await client.getTransactionReceipt({
        hash: txHash as Hash,
      });
      if (!receipt) {
        return { ok: false, reason: `Tx ${txHash} not mined yet.` };
      }
      if (receipt.status !== "success") {
        return { ok: false, reason: `Tx ${txHash} reverted.` };
      }

      const tx = await client.getTransaction({ hash: txHash as Hash });
      if (!tx) {
        return { ok: false, reason: `Tx ${txHash} not found.` };
      }
      // `to` is the immediate recipient of the top-level call. For a
      // direct USDC transfer the user signs into GatewayWallet this IS
      // the Gateway wallet. For an ERC-4337 bundler call, `to` is the
      // EntryPoint, not GatewayWallet — the ERC-4337 path recovers the
      // destination from the UserOp calldata, which is out of scope
      // here. Task prompt §Rules permits accepting + warning in that
      // case: log and fall back.
      const toAddr = (tx.to ?? "").toLowerCase();
      if (toAddr !== expectedTo.toLowerCase()) {
        if (skipFromCheck) {
          // Paymaster path — `to` is EntryPoint. Accept and warn (task
          // prompt §Rules on-chain-verification carve-out).
          this.logger.warn(
            `Deposit tx ${txHash.slice(0, 10)}… has to=${toAddr} (not GatewayWallet); accepting because usedCirclePaymaster=true (TODO: parse UserOp calldata).`,
          );
          return { ok: true };
        }
        return {
          ok: false,
          reason: `Tx recipient ${toAddr} does not match Gateway wallet ${expectedTo}.`,
        };
      }

      if (!skipFromCheck) {
        if (!expectedFrom) {
          return {
            ok: false,
            reason: "Payer wallet address is unknown; cannot verify tx sender.",
          };
        }
        if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
          return {
            ok: false,
            reason: `Tx sender ${tx.from} does not match payer ${expectedFrom}.`,
          };
        }
      }

      return { ok: true };
    } catch (err) {
      // RPC blip — prefer accepting with a warn over a hard 400 per the
      // task prompt's fallback carve-out. The audit row + the txHash
      // unique index still let ops reconcile against Circle later.
      this.logger.warn(
        `Deposit tx verification threw for ${txHash.slice(0, 10)}…: ${err instanceof Error ? err.message : String(err)}; accepting (TODO: tighten).`,
      );
      return { ok: true };
    }
  }

  /**
   * Turn a {@link CircleSettleOutcome} into the right DB writes and the
   * wire response. Split out of `submitNanopay` so it's easier to test
   * and easier to reason about the state-machine branches.
   *
   * State transitions:
   *   - ok       → create submission with `circleSettleTxUuid`, flip intent to SETTLED, fire Xendit.
   *   - rejected → create submission with `failureCode`/`failureMessage`, flip intent to FAILED.
   *   - upstream → create submission with CIRCLE_UPSTREAM_ERROR, flip intent to FAILED.
   *   - timeout  → create submission WITHOUT `circleSettleTxUuid`, leave intent SETTLED? NO.
   *                Flip intent to SETTLING (spec: in-flight, retry-safe; don't claim FAILED
   *                because Circle might actually settle once the network recovers).
   *
   * All four branches are wrapped in a single transaction so the submission
   * row and the intent status stay in lockstep — a half-landed write is
   * the worst thing that can happen to reconciliation.
   */
  private async persistOutcome(args: {
    intent: {
      id: string;
      status: PaymentIntentStatus;
      payerUserId: string | null;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      nanopayUsdcTreasuryAddress: string | null;
      merchant: { displayName: string };
      payer: { walletAddress: string | null } | null;
    };
    signature: Uint8Array;
    submittedAt: Date;
    outcome: CircleSettleOutcome;
  }): Promise<NanopaySubmitResponseDto> {
    const { intent, signature, submittedAt, outcome } = args;

    if (outcome.kind === "ok") {
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature,
            submittedAt,
            circleSettleTxUuid: outcome.response.transaction,
            circleSettleResponseReceivedAt: submittedAt,
            circleSettleNetwork: outcome.response.network,
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "SETTLED" },
        });
        return created;
      });

      this.logger.log(
        `[persistOutcome] intent=${intent.id} SETTLED circleUuid=${outcome.response.transaction ?? "n/a"} merchant="${intent.merchant.displayName}" usdcMicros=${intent.nanopayUsdcAmountMicros?.toString()}`,
      );
      this.kickPayout(intent.id);
      this.recordMerchantPayment(intent);

      return this.toSubmissionResponse(intent.id, submission);
    }

    if (outcome.kind === "rejected") {
      const { code, message } = mapCircleErrorReason(
        outcome.response.errorReason,
        outcome.response.message,
      );
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature,
            submittedAt,
            circleSettleResponseReceivedAt: submittedAt,
            circleSettleNetwork: outcome.response.network ?? null,
            failureCode: code,
            // Raw `errorReason` kept for debugging (spec §6.5 last paragraph).
            // Fall back to a message echo if Circle didn't send one.
            failureMessage: outcome.response.errorReason ?? message,
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED" },
        });
        return created;
      });
      // Redacted log — never include the signature or nonce (user scope §5
      // "Never log signatures or nonces").
      this.logger.warn(
        `Nanopay settle rejected for intent=${intent.id} code=${code} status=${outcome.status}`,
      );
      return this.toSubmissionResponse(intent.id, submission);
    }

    if (outcome.kind === "upstream") {
      const submission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.nanopaySubmission.create({
          data: {
            intentId: intent.id,
            signature,
            submittedAt,
            circleSettleResponseReceivedAt: submittedAt,
            failureCode: "CIRCLE_UPSTREAM_ERROR",
            failureMessage: truncateMessage(outcome.message),
          },
        });
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED" },
        });
        return created;
      });
      this.logger.error(
        `Nanopay settle upstream error for intent=${intent.id} status=${outcome.status ?? "n/a"}`,
      );
      return this.toSubmissionResponse(intent.id, submission);
    }

    // timeout — do NOT flip to FAILED. Circle may have received the
    // authorization and may yet settle it. SETTLING tells the polling
    // client "come back in a moment; it's not over yet."
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.nanopaySubmission.create({
        data: {
          intentId: intent.id,
          signature,
          submittedAt,
          // No `circleSettleResponseReceivedAt` — we didn't receive one.
          failureCode: null,
          failureMessage: truncateMessage(outcome.message),
        },
      });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        // NOTE: SETTLING is not a DB enum value (see schema.prisma
        // `PaymentIntentStatus`). We map the in-flight state onto SIGNED
        // so polling clients see a non-terminal status and keep polling.
        // A dedicated SETTLING enum is a follow-up schema change — adding
        // it here would require a migration and churn the unrelated GET
        // projection. The wire response surfaces "SETTLING" verbatim.
        data: { status: "SIGNED" },
      });
      return created;
    });
    this.logger.warn(
      `Nanopay settle timed out for intent=${intent.id}; marked in-flight (SETTLING).`,
    );
    return {
      intentId: intent.id,
      status: "SETTLING",
      attestation: null,
      failure: null,
    };
  }

  /**
   * Fire-and-forget Xendit trigger. Wrapped here rather than inline at
   * each call site so the same null-provider posture applies uniformly.
   * Returns void — errors are logged and swallowed because the payer's
   * Circle settle has already succeeded from their POV.
   */
  private kickPayout(intentId: string): void {
    if (!this.payoutProvider) {
      // TODO(task-29): wire `XenditPayoutProvider` once it lands. Until
      // then the settle 200 flow stops here — ops must manually disburse
      // or wait for the provider module to be imported.
      this.logger.log(
        `PayoutProvider not wired; intent ${intentId} is SETTLED but Xendit trigger is a no-op.`,
      );
      return;
    }
    try {
      const maybePromise = this.payoutProvider.trigger(intentId);
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).then === "function"
      ) {
        (maybePromise as Promise<void>).catch((err) => {
          this.logger.error(
            `PayoutProvider.trigger threw asynchronously for intent ${intentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      this.logger.error(
        `PayoutProvider.trigger threw synchronously for intent ${intentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fire-and-forget: write a `TransactionHistory` row for a settled
   * merchant payment so the user sees it in their activity feed.
   * Swallowed on failure — the intent settlement is already committed;
   * a missing history row is recoverable via backfill, a rolled-back
   * settlement is not.
   */
  private recordMerchantPayment(
    intent: {
      id: string;
      payerUserId: string | null;
      sourceTokenId: string | null;
      nanopayUsdcAmountMicros: bigint | null;
      fiatAmountMinor: number;
      fiatCurrency: string;
      merchant: { displayName: string };
      payer: { walletAddress: string | null } | null;
      nanopayUsdcTreasuryAddress: string | null;
    },
    txHash?: string,
    status: "PENDING" | "COMPLETED" = "COMPLETED",
  ): void {
    if (!intent.payerUserId || !intent.sourceTokenId) {
      this.logger.warn(
        `[recordMerchantPayment] skipping intent=${intent.id} — missing payerUserId=${intent.payerUserId ?? "null"} or sourceTokenId=${intent.sourceTokenId ?? "null"}`,
      );
      return;
    }

    this.logger.log(
      `[recordMerchantPayment] intent=${intent.id} userId=${intent.payerUserId} merchant="${intent.merchant.displayName}" usdcMicros=${intent.nanopayUsdcAmountMicros?.toString()} fiat=${intent.fiatAmountMinor}${intent.fiatCurrency} txHash=${txHash ?? "n/a"}`,
    );

    const amount = intent.nanopayUsdcAmountMicros?.toString() ?? "0";

    this.transactionsService
      .create(intent.payerUserId, {
        tokenId: intent.sourceTokenId,
        type: "PAYMENT" as TransactionType,
        status: status as TransactionStatus,
        amount,
        amountInFiat: intent.fiatAmountMinor.toString(),
        fiatCurrency: intent.fiatCurrency,
        txHash: txHash ?? undefined,
        fromAddress: intent.payer?.walletAddress ?? undefined,
        toAddress: intent.nanopayUsdcTreasuryAddress ?? undefined,
        merchantName: intent.merchant.displayName,
        paymentIntentId: intent.id,
      })
      .catch((err) => {
        this.logger.error(
          `Failed to record transaction history for intent=${intent.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Map a persisted NanopaySubmission row to the wire response. */
  private toSubmissionResponse(
    intentId: string,
    row: {
      circleSettleTxUuid: string | null;
      circleSettleResponseReceivedAt: Date | null;
      failureCode: string | null;
      failureMessage: string | null;
    },
  ): NanopaySubmitResponseDto {
    if (row.circleSettleTxUuid) {
      return {
        intentId,
        status: "SETTLED",
        attestation: {
          id: row.circleSettleTxUuid,
          receivedAt: (
            row.circleSettleResponseReceivedAt ?? new Date()
          ).getTime(),
        },
        failure: null,
      };
    }
    if (row.failureCode) {
      return {
        intentId,
        status: "FAILED",
        attestation: null,
        failure: {
          code: row.failureCode as NanopayFailureCode,
          message: row.failureMessage ?? row.failureCode,
        },
      };
    }
    // Neither tx uuid nor failure code — this is the timeout row. Surface
    // as SETTLING so retry-safe clients keep polling the intent.
    return {
      intentId,
      status: "SETTLING",
      attestation: null,
      failure: null,
    };
  }

  /**
   * Look up the most recent active FX row for `fromCurrency → currency` in
   * region `ID`. `fromCurrency` is the settlement token's symbol (USDC,
   * AUSD, …). Returns null if no row matches — caller turns that into 503.
   */
  private async snapshotLatestFx(
    fromCurrency: string,
    currency: "IDR",
  ): Promise<ResolvedFx | null> {
    const row = await this.prisma.exchangeRate.findFirst({
      where: {
        fromCurrency,
        toCurrency: currency,
        region: "ID",
        isActive: true,
      },
      orderBy: { createdAt: "desc" },
      include: { sourceProvider: true },
    });
    if (!row) return null;

    return {
      exchangeRateId: row.id,
      exchangeRateCreatedAt: row.createdAt,
      fxRate: row.rate.toString(),
      fxMarkup: (row.markup ?? 0).toString(),
      fxFromCurrency: row.fromCurrency,
      fxToCurrency: row.toCurrency,
      fxProvider: row.provider ?? row.sourceProvider?.name ?? "unknown",
      fxQuotedAt: row.createdAt,
    };
  }

  private async lookupIdempotent(
    key: string,
  ): Promise<IdempotencyEnvelope | null> {
    try {
      return await this.valkey.get<IdempotencyEnvelope>(
        `${IDEMPOTENCY_KEY_PREFIX}${key}`,
      );
    } catch (err) {
      // Valkey unavailable — degrade to no-idempotency rather than 500ing.
      // Retries may produce duplicate intents, but the DB unique index on
      // nanopay_nonce makes that a soft duplication (different nonce each
      // time) rather than a correctness bug on the signed authorization.
      this.logger.warn(
        `Idempotency cache read failed (key=${redactKey(key)}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async persistIdempotent(
    key: string,
    envelope: IdempotencyEnvelope,
  ): Promise<void> {
    try {
      await this.valkey.set(`${IDEMPOTENCY_KEY_PREFIX}${key}`, envelope, {
        ttl: IDEMPOTENCY_TTL_SECONDS,
      });
    } catch (err) {
      // Same degradation posture as the read path — warn, don't fail the
      // user's request for a cache write blip.
      this.logger.warn(
        `Idempotency cache write failed (key=${redactKey(key)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Compute USDC atomic units (6-decimal micros) from fiat minor units, a
 * decimal-string FX rate, and a decimal-string markup multiplier.
 *
 * Invariants:
 *   - `fxRate` is `<currency> per 1 USDC` (e.g. 15700 IDR/USDC).
 *   - `markupMultiplier` is `1 + markup_fraction` (e.g. 1.015 for 1.5%).
 *   - Returns USDC atomic units (1e-6 USDC each).
 *
 * Formula, rounded up:
 *   usdcMicros = fiatMinor × 1_000_000 × markupMultiplier / (fxRate × fiatMinorFactor)
 * where `fiatMinorFactor` is 1 for IDR (QRIS uses integer rupiah) — change
 * when adding a currency whose minor unit actually differs.
 *
 * The markup raises what the payer sends, and rounding up keeps them from
 * underpaying: result ≥ fiat / fxRate whenever markup ≥ 0.
 *
 * We route both FX rate and markup through a shared string→bigint scaler
 * so a 1.5%-style markup doesn't lose precision to JS number math.
 */
export function computeUsdcMicros(args: {
  fiatAmountMinor: bigint;
  fxRate: string;
  markupMultiplier: string;
}): bigint {
  const rateScaled = parseDecimalToScaled(args.fxRate, 18);
  const markupScaled = parseDecimalToScaled(args.markupMultiplier, 18);
  if (rateScaled <= 0n || markupScaled <= 0n) {
    throw new Error("FX rate and markup must be positive.");
  }

  // Both are scaled to 1e18, so the scales cancel in markup / rate.
  const numerator = args.fiatAmountMinor * 1_000_000n * markupScaled;
  return (numerator + rateScaled - 1n) / rateScaled;
}

/**
 * Parse a decimal string ("1.5", "15700", "1.015") into an integer scaled
 * to `decimals` fractional digits. Throws on malformed input.
 */
function parseDecimalToScaled(input: string, decimals: number): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(input)) {
    throw new Error(`Not a decimal: ${input}`);
  }
  const [whole, frac = ""] = input.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  const scaled = BigInt(wholeAbs + fracPadded);
  return sign * scaled;
}

/**
 * Convert a percent-markup (e.g. "1.5" meaning 1.5%) into a decimal-string
 * multiplier ("1.015"). FX rows store markup as a percent, not a fraction.
 */
export function addMarkup(markupPercent: string): string {
  const scaled = parseDecimalToScaled(markupPercent, 18);
  const one = 10n ** 18n;
  const hundred = 100n * one;
  // multiplier = 1 + markupPercent / 100 → ((100 + markupPercent) / 100) scaled.
  const mulScaled = ((hundred + scaled) * one) / hundred;
  return scaledToDecimalString(mulScaled, 18);
}

function scaledToDecimalString(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  const out = frac.length > 0 ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * SHA-256 fingerprint of an arbitrary string → 32-byte Uint8Array. Used by
 * the SVM submit path to derive a stable dedup key from the base64-encoded
 * signed transaction (task 43). We re-use `NanopaySubmission.signature`
 * (Bytes) as the storage column — the fingerprint is not a crypto signature
 * but it lives in the same audit column because the natural key is
 * `(intentId, payload-hash)` on both rails.
 */
function sha256Bytes(input: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

/**
 * Narrow a thrown error to Prisma's `P2002` unique-constraint violation.
 * We don't import `Prisma.PrismaClientKnownRequestError` here because the
 * Prisma 7 generated client exports its error classes from the generated
 * path and the narrower structural check is stable across versions.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2002";
}

/** Redact most of an idempotency key for logging (first 8 chars only). */
function redactKey(key: string): string {
  return `${key.slice(0, 8)}…(${key.length})`;
}

/**
 * Map Circle's `errorReason` enum to our `NanopayFailureCode` (spec §6.5
 * last paragraph). Unknown strings fall through to CIRCLE_UPSTREAM_ERROR —
 * we prefer a typed fallback to a cryptic passthrough, and the raw
 * reason is persisted on `failure_message` for ops debugging either way.
 *
 * Exported so the test spec can assert each mapping branch without a
 * full DB + HTTP round-trip.
 */
export function mapCircleErrorReason(
  errorReason: string | undefined,
  upstreamMessage: string | undefined,
): { code: NanopayFailureCode; message: string } {
  const fallbackMessage =
    upstreamMessage ??
    errorReason ??
    "Circle settle rejected the authorization.";
  if (!errorReason) {
    return { code: "CIRCLE_UPSTREAM_ERROR", message: fallbackMessage };
  }
  switch (errorReason) {
    case "insufficient_balance":
      return { code: "INSUFFICIENT_GATEWAY_BALANCE", message: fallbackMessage };
    case "nonce_already_used":
      return { code: "NONCE_REUSED", message: fallbackMessage };
    case "authorization_not_yet_valid":
    case "authorization_expired":
    case "authorization_validity_too_short":
      return { code: "AUTHORIZATION_EXPIRED", message: fallbackMessage };
    case "unsupported_scheme":
    case "unsupported_network":
    case "unsupported_asset":
    case "invalid_payload":
    case "address_mismatch":
    case "amount_mismatch":
    case "invalid_signature":
      return { code: "SIGNATURE_INVALID", message: fallbackMessage };
    case "self_transfer":
    case "unsupported_domain":
    case "wallet_not_found":
      return { code: "CIRCLE_UPSTREAM_ERROR", message: fallbackMessage };
    default:
      return { code: "CIRCLE_UPSTREAM_ERROR", message: fallbackMessage };
  }
}

/**
 * Convert a `0x`-prefixed hex string to a Uint8Array. Mirrors the
 * `nanopayNonce` bytes path — we go through Buffer to keep the branch
 * cheap at request time (Node's `Buffer.from(hex)` is a single native
 * call).
 */
function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error("Hex string must have even length.");
  }
  return new Uint8Array(Buffer.from(stripped, "hex"));
}

/**
 * Truncate an arbitrary upstream message to a safe length before writing
 * to `failure_message`. Some Circle 5xx responses carry verbose HTML
 * error pages — we don't want those to bloat the DB row. 500 chars is
 * plenty for the typical "insufficient_balance" / "nonce_already_used"
 * envelope Circle emits.
 */
function truncateMessage(message: string | undefined): string | null {
  if (!message) return null;
  return message.length > 500 ? `${message.slice(0, 497)}…` : message;
}

function extractQrisPan(payload: string): string | null {
  if (!payload.startsWith("000201")) return null;
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const lenStr = payload.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) return null;
    const len = Number.parseInt(lenStr, 10);
    const start = i + 4;
    const end = start + len;
    if (end > payload.length) return null;
    const tagNum = Number.parseInt(tag, 10);
    if (tagNum >= 26 && tagNum <= 51) {
      let j = 0;
      const sub = payload.slice(start, end);
      while (j + 4 <= sub.length) {
        const subTag = sub.slice(j, j + 2);
        const subLenStr = sub.slice(j + 2, j + 4);
        if (!/^\d{2}$/.test(subTag) || !/^\d{2}$/.test(subLenStr)) break;
        const subLen = Number.parseInt(subLenStr, 10);
        const subStart = j + 4;
        const subEnd = subStart + subLen;
        if (subEnd > sub.length) break;
        if (subTag === "01") return sub.slice(subStart, subEnd);
        j = subEnd;
      }
    }
    i = end;
  }
  return null;
}
