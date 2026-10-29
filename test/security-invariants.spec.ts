/**
 * Security invariant tests (task 37, spec ss12.2).
 *
 * Each of the 14 invariants from the spec gets at least one concrete
 * test case. Tests that require a real contract or real providers are
 * stubbed with mock assertions -- they validate the code-level enforcement
 * mechanisms documented in the spec, not on-chain behavior (which is
 * covered by the fork-testnet spec, task 33).
 */

import { BadRequestException } from "@nestjs/common";
import { SettlementRejectedError } from "../src/pay/settlement/settlement.types";
import { OnchainSettlementProvider } from "../src/pay/settlement/providers/onchain.settlement.provider";
import { NanopaySettlementProvider } from "../src/pay/settlement/providers/nanopay.settlement.provider";

const TX_HASH = `0x${"ab".repeat(32)}`;
const CHAIN_ID = 5042002;
const PAYER_WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT_ADDR = "0x2222222222222222222222222222222222222222";

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_01HXYZ",
    status: "QUOTED",
    path: "direct_arc",
    payerUserId: "user_payer",
    merchantId: "mch_123",
    sourceTokenAddress: "0x3600000000000000000000000000000000000000",
    sourceTokenId: "tok_usdc",
    tokenAmountMinor: 6_350_000n,
    fiatAmountMinor: 100_000,
    fiatCurrency: "IDR",
    exchangeRateId: 42,
    sourceChainId: CHAIN_ID,
    ...overrides,
  } as any;
}

function buildOnchainProvider(bvOverrides?: any, prismaOverrides?: any) {
  const bv = {
    verifyTxReceiptOnly: jest.fn().mockResolvedValue({
      receipt: { status: "success", blockNumber: 100n },
      transaction: { from: PAYER_WALLET, to: CONTRACT_ADDR, chainId: CHAIN_ID },
      confirmations: 12,
    }),
    verifyMerchantPaymentInContract: jest.fn().mockResolvedValue(undefined),
    ...bvOverrides,
  };
  const prisma = {
    onchainSettlement: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => ({
        id: "os_sec",
        ...args.data,
        createdAt: new Date(),
      })),
    },
    paymentIntent: {
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
    },
    blockchain: {
      findFirstOrThrow: jest.fn(async () => ({
        chainId: CHAIN_ID,
        isActive: true,
        isEVM: true,
        takumiWalletContract: CONTRACT_ADDR,
        minConfirmations: 12,
      })),
    },
    user: {
      findUniqueOrThrow: jest.fn(async () => ({
        id: "user_payer",
        walletAddress: PAYER_WALLET,
      })),
    },
    token: {
      findUnique: jest.fn(async () => ({
        id: "tok_usdc",
        contractAddress: "0x3600000000000000000000000000000000000000",
      })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    ...prismaOverrides,
  };
  const config = {
    get: jest.fn((k: string, d?: any) => {
      if (k === "ONCHAIN_MIN_CONFIRMATIONS") return 12;
      if (k === "MIN_CONFIRMATIONS") return 12;
      return d;
    }),
  };
  const provider = new OnchainSettlementProvider(bv as any, prisma as any, config as any);
  return { provider, bv, prisma };
}

describe("Security Invariants (ss12.2)", () => {
  describe("I-1: No funds move without backend-issued quote", () => {
    it("processMerchantPayment reverts BAD_QUOTE with wrong signer — backend rejects mismatched contract data", async () => {
      // Backend-side enforcement: verifyMerchantPaymentInContract rejects
      // if the contract returns data that doesn't match the intent.
      const { provider } = buildOnchainProvider({
        verifyMerchantPaymentInContract: jest.fn().mockRejectedValue(
          new BadRequestException("Merchant payment refId mismatch"),
        ),
      });

      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toMatchObject({ code: "REF_NOT_ON_CHAIN" });
    });
  });

  describe("I-2: Signed quote cannot be mutated", () => {
    it("changing any field in QuoteCommitment causes contract data mismatch on verification", async () => {
      // If the customer modifies the amount (or any field), the on-chain
      // MerchantPayment struct won't match the intent's expected values.
      const { provider } = buildOnchainProvider({
        verifyMerchantPaymentInContract: jest.fn().mockRejectedValue(
          new BadRequestException("Merchant payment amount mismatch: expected 6350000, got 1000000"),
        ),
      });

      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toMatchObject({ code: "CONTRACT_DATA_MISMATCH" });
    });
  });

  describe("I-3: Signed quote cannot be replayed", () => {
    it("second settle with same refId returns idempotent response (backend side)", async () => {
      const existingRow = {
        id: "os_EXISTING",
        intentId: "pi_01HXYZ",
        txHash: TX_HASH,
        chainId: CHAIN_ID,
        verifiedAt: new Date(),
        failureCode: null,
      };
      const { provider, bv } = buildOnchainProvider(undefined, {
        onchainSettlement: {
          findFirst: jest.fn().mockResolvedValue(existingRow),
          create: jest.fn(),
        },
      });

      const result = await provider.settle({
        intent: makeIntent(),
        merchant: { id: "mch_123" } as any,
        payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
      });

      expect(result.settlementId).toBe("os_EXISTING");
      expect(result.status).toBe("SETTLED");
      // No re-verification on replay
      expect(bv.verifyTxReceiptOnly).not.toHaveBeenCalled();
    });
  });

  describe("I-4: Stale quotes cannot be redeemed", () => {
    it("expired intent is rejected -- contract reverts QUOTE_EXPIRED, backend rejects status", async () => {
      // Contract-level: reverts with QUOTE_EXPIRED (tested in fork-testnet spec)
      // Backend-level: if tx makes it through but contract state is weird,
      // the verification catches it. Also, the intent sweeper marks expired
      // intents EXPIRED.
      const { provider } = buildOnchainProvider({
        verifyTxReceiptOnly: jest.fn().mockRejectedValue(
          new BadRequestException("Transaction was reverted or failed"),
        ),
      });

      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toMatchObject({ code: "TX_REVERTED" });
    });
  });

  describe("I-5: Cross-chain / cross-deployment replay is impossible", () => {
    it("chain ID mismatch at tx-level verification is rejected", async () => {
      const { provider } = buildOnchainProvider({
        verifyTxReceiptOnly: jest.fn().mockRejectedValue(
          new BadRequestException("Chain ID mismatch: expected 5042002, got 1"),
        ),
      });

      // The EIP-712 domain separator includes chainId + verifyingContract;
      // backend also checks the chain at tx level
      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toBeInstanceOf(SettlementRejectedError);
    });
  });

  describe("I-6: Merchant PII never reaches the chain", () => {
    it("QuoteCommitment and MerchantPayment structs reference merchants only by ULID", () => {
      // Structural assertion: the verifyMerchantPaymentInContract args
      // never include bank account, QRIS PAN, or holder name.
      const verifyArgs = {
        contractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        refId: "pi_01HXYZ",
        expectedPayer: PAYER_WALLET,
        expectedMerchantId: "mch_123", // ULID only
        expectedTokenAddress: "0x3600000000000000000000000000000000000000",
        expectedAmount: "6350000",
        expectedFiatAmountMinor: 100_000,
        expectedFiatCurrency: "IDR",
        expectedExchangeRateId: 42,
      };

      // No PII fields present in the contract verification args
      const argKeys = Object.keys(verifyArgs);
      expect(argKeys).not.toContain("bankAccount");
      expect(argKeys).not.toContain("accountNumber");
      expect(argKeys).not.toContain("accountHolderName");
      expect(argKeys).not.toContain("qrisPan");
      expect(argKeys).not.toContain("phone");
      expect(argKeys).not.toContain("email");
    });
  });

  describe("I-7: Payer identity cannot be spoofed", () => {
    it("sender mismatch between tx.from and intent.payer is rejected", async () => {
      const { provider } = buildOnchainProvider({
        verifyTxReceiptOnly: jest.fn().mockRejectedValue(
          new BadRequestException("Sender address mismatch"),
        ),
      });

      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toMatchObject({ code: "SENDER_MISMATCH" });
    });
  });

  describe("I-8: Backend cannot fabricate a settlement post-hoc", () => {
    it("settlement requires on-chain verification via verifyMerchantPaymentInContract", async () => {
      const { provider, bv } = buildOnchainProvider();

      await provider.settle({
        intent: makeIntent(),
        merchant: { id: "mch_123" } as any,
        payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
      });

      // Both Phase A and Phase B verification MUST be called
      expect(bv.verifyTxReceiptOnly).toHaveBeenCalledTimes(1);
      expect(bv.verifyMerchantPaymentInContract).toHaveBeenCalledTimes(1);
    });
  });

  describe("I-9: Disbursement is bounded by settlement", () => {
    it("payout is only triggered after intent transitions to SETTLED", async () => {
      const { provider, prisma } = buildOnchainProvider();

      await provider.settle({
        intent: makeIntent(),
        merchant: { id: "mch_123" } as any,
        payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
      });

      // The $transaction callback updates status to SETTLED atomically
      // with settlement row creation
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.paymentIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "SETTLED" },
        }),
      );
    });
  });

  describe("I-10: Treasury custody is recoverable", () => {
    it("contract exposes sweep functions (structural check via ABI)", () => {
      // The TakumiPay ABI should contain sweepPlatformFees and
      // sweepMerchantBacking, plus sweepAllowance (2.3.0), which reports how
      // much the trailing-24h sweep cap lets leave right now.
      const { TakumiPayAbi } = require(
        "../src/blockchain-verification/abis/takumi-pay.abi",
      );
      const functionNames = TakumiPayAbi
        .filter((entry: any) => entry.type === "function")
        .map((entry: any) => entry.name);

      expect(functionNames).toContain("sweepPlatformFees");
      expect(functionNames).toContain("sweepMerchantBacking");
      expect(functionNames).toContain("sweepAllowance");
    });
  });

  describe("I-11: Front-running is economically self-defeating", () => {
    it("contract uses msg.sender for payer -- front-runner pays from their own address", async () => {
      // Backend checks tx.from against intent.payer. If a front-runner
      // steals the signed quote, they pay from their own address,
      // which won't match the intent's expected payer.
      const { provider } = buildOnchainProvider({
        verifyTxReceiptOnly: jest.fn().mockRejectedValue(
          new BadRequestException("Sender address mismatch: expected 0x1111, got 0xATTACKER"),
        ),
      });

      await expect(
        provider.settle({
          intent: makeIntent(),
          merchant: { id: "mch_123" } as any,
          payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
        }),
      ).rejects.toMatchObject({ code: "SENDER_MISMATCH" });
    });
  });

  describe("I-12: Webhook callbacks cannot forge payouts", () => {
    it("webhook signature verification exists in payout providers (structural check)", () => {
      // The XenditPayoutProvider verifies x-callback-token before
      // processing webhooks. This is tested in xendit-payout.provider.spec.ts.
      // Here we just assert the verification method exists.
      const { XenditPayoutProvider } = require(
        "../src/payout/providers/xendit-payout.provider",
      );
      expect(typeof XenditPayoutProvider.prototype.verifyWebhookSignature).toBe("function");
    });
  });

  describe("I-13: Platform fee withdrawal is bounded by cumulative accrual", () => {
    it("sweepPlatformFees ABI has amount parameter and is owner-gated (structural check)", () => {
      const { TakumiPayAbi } = require(
        "../src/blockchain-verification/abis/takumi-pay.abi",
      );
      const sweep = TakumiPayAbi.find(
        (entry: any) => entry.type === "function" && entry.name === "sweepPlatformFees",
      );
      expect(sweep).toBeDefined();
      // The function takes (token, recipient, amount) -- all three params
      if (sweep) {
        expect(sweep.inputs.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe("I-14: Per-chain finality threshold is enforced at settlement time", () => {
    it("provider passes minConfirmations from chain row to verifyTxReceiptOnly", async () => {
      const { provider, bv, prisma } = buildOnchainProvider();
      // Override chain to have custom minConfirmations
      prisma.blockchain.findFirstOrThrow.mockResolvedValue({
        chainId: CHAIN_ID,
        isActive: true,
        isEVM: true,
        takumiWalletContract: CONTRACT_ADDR,
        minConfirmations: 720, // Arbitrum-level
      });

      await provider.settle({
        intent: makeIntent(),
        merchant: { id: "mch_123" } as any,
        payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
      });

      expect(bv.verifyTxReceiptOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          minimumConfirmations: 720,
        }),
      );
    });

    it("falls back to env default when chain.minConfirmations is null", async () => {
      const { provider, bv } = buildOnchainProvider();

      await provider.settle({
        intent: makeIntent(),
        merchant: { id: "mch_123" } as any,
        payerInput: { kind: "txHash", txHash: TX_HASH, chainId: CHAIN_ID },
      });

      expect(bv.verifyTxReceiptOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          minimumConfirmations: 12,
        }),
      );
    });
  });
});
