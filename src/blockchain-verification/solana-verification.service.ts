import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { Idl, Wallet } from "@coral-xyz/anchor";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Commitment, Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { resolveRpcEndpoint } from "../blockchains/rpc-endpoint";
import { PrismaService } from "../prisma/prisma.service";
import { TAKUMI_PAY_IDL } from "./solana/takumi-pay/idl";
import {
  deriveConfigPda,
  deriveMerchantPaymentPda,
  derivePointDepositPda,
  derivePointRefRecordPda,
  deriveRefRecordPda,
  deriveTxRecordPda,
} from "./solana/takumi-pay/pda";
import { computeRefIdHash } from "./solana/takumi-pay/ref-id-hash";
import type {
  MerchantQuoteParams,
  TakumiPayMerchantPayment,
  TakumiPayPointDepositRecord,
  TakumiPayTransactionRecord,
} from "./solana/takumi-pay/types";
import type { TTransactionVerificationResult } from "./types/blockchain-verification.types";

interface SolanaClient {
  connection: Connection;
  // biome-ignore lint/suspicious/noExplicitAny: Anchor program accessed dynamically by account name; on-chain IDL has no generated TS type, so Program<Idl> drops the account namespace and breaks every call site.
  program: any;
}

/** How long one verification attempt waits for a signature to confirm. */
const CONFIRMATION_POLL_WINDOW_MS = 45_000;
const CONFIRMATION_POLL_INTERVAL_MS = 2_000;

@Injectable()
export class SolanaVerificationService implements OnModuleInit {
  private readonly logger = new Logger(SolanaVerificationService.name);
  private readonly clients: Map<string, SolanaClient> = new Map();
  private signerKeypair: Keypair | null = null;

  private static readonly SOLANA_SLUGS = ["solana-mainnet", "solana-devnet"];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.initializeClients();

    const signerKey = this.config.get<string>(
      "SOLANA_QUOTE_SIGNER_PRIVATE_KEY",
    );
    if (signerKey) {
      try {
        const decoded = JSON.parse(signerKey);
        this.signerKeypair = Keypair.fromSecretKey(new Uint8Array(decoded));
      } catch {
        this.logger.warn("Failed to parse SOLANA_QUOTE_SIGNER_PRIVATE_KEY");
      }
    }
  }

  private async initializeClients() {
    const chains = await this.prisma.blockchain.findMany({
      where: {
        chainSlug: { in: SolanaVerificationService.SOLANA_SLUGS },
        isActive: true,
      },
    });

    if (chains.length === 0) {
      const msg =
        "No active Solana blockchain rows found (chainSlug in [solana-mainnet, solana-devnet]). " +
        "Seed the Blockchain table before starting the application.";
      this.logger.error(msg);
      throw new Error(msg);
    }

    for (const chain of chains) {
      // `rpcUrl` is an rpc-proxy route; resolve to an absolute URL and pass the
      // proxy bearer through (`httpHeaders` is {} when the proxy has no auth).
      const rpc = resolveRpcEndpoint(chain.rpcUrl);
      const connection = new Connection(rpc.url, {
        commitment: "confirmed",
        httpHeaders: rpc.headers,
      });
      const dummyWallet = {
        publicKey: PublicKey.default,
        signTransaction: <T>(tx: T) => Promise.resolve(tx),
        signAllTransactions: <T>(txs: T) => Promise.resolve(txs),
      } as unknown as Wallet;
      const provider = new AnchorProvider(connection, dummyWallet, {
        commitment: "confirmed",
      });
      const program = new Program(TAKUMI_PAY_IDL as unknown as Idl, provider);

      this.clients.set(chain.id, { connection, program });
      this.logger.log(
        `Initialized Solana client for ${chain.name} (slug: ${chain.chainSlug})`,
      );
    }
  }

  private getClient(blockchainId: string): SolanaClient {
    const client = this.clients.get(blockchainId);
    if (!client) {
      throw new Error(
        `No Solana client initialized for blockchain ${blockchainId}`,
      );
    }
    return client;
  }

  /**
   * Polls `getSignatureStatuses` until `signature` reaches `commitment`.
   *
   * Not `confirmTransaction`: it waits on a WebSocket signature subscription,
   * which rpc-proxy does not carry, and it was handed a fresh blockhash
   * rather than the transaction's own. Together that reported finalized
   * payments as "block height exceeded" on every retry, so they never
   * settled.
   *
   * A failed transaction throws a "reverted or failed" message, which
   * `classifySettlementError` treats as a chain verdict. Anything still
   * unconfirmed after the window throws a plain error, which is transient:
   * the settlement queue retries with its own backoff.
   */
  async waitForConfirmation(
    blockchainId: string,
    signature: string,
    commitment: Commitment = "finalized",
  ): Promise<void> {
    const { connection } = this.getClient(blockchainId);
    const wanted =
      commitment === "finalized"
        ? ["finalized"]
        : ["confirmed", "finalized"];
    const deadline = Date.now() + CONFIRMATION_POLL_WINDOW_MS;
    for (;;) {
      const {
        value: [status],
      } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      if (status?.err) {
        throw new Error(
          `Solana transaction ${signature} reverted or failed: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.confirmationStatus &&
        wanted.includes(status.confirmationStatus)
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Solana transaction ${signature} not ${commitment} yet (status: ${status?.confirmationStatus ?? "not found"})`,
        );
      }
      await new Promise((r) => setTimeout(r, CONFIRMATION_POLL_INTERVAL_MS));
    }
  }

  async verifyTransaction(args: {
    blockchainId: string;
    programId: PublicKey;
    transactionSignature: string;
    refId: string;
    refIdHash: Uint8Array;
    expectedWalletAddress: string;
    expectedTokenMint: string;
    expectedAmount: string;
    expectedBookingId: string;
    expectedExchangeRateId: string;
    expectedProductVariantId: string;
  }): Promise<TTransactionVerificationResult> {
    const { connection } = this.getClient(args.blockchainId);

    await this.waitForConfirmation(
      args.blockchainId,
      args.transactionSignature,
      "confirmed",
    );

    const txResponse = await connection.getTransaction(
      args.transactionSignature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    );

    if (!txResponse) {
      throw new Error(
        `Solana transaction ${args.transactionSignature} not found`,
      );
    }

    if (txResponse.meta?.err) {
      throw new Error(
        `Solana transaction ${args.transactionSignature} failed: ${JSON.stringify(txResponse.meta.err)}`,
      );
    }

    const txRecord = await this.verifyTransactionRecord({
      blockchainId: args.blockchainId,
      programId: args.programId,
      refId: args.refId,
      refIdHash: args.refIdHash,
      expectedWalletAddress: args.expectedWalletAddress,
      expectedTokenMint: args.expectedTokenMint,
      expectedAmount: args.expectedAmount,
      expectedBookingId: args.expectedBookingId,
      expectedExchangeRateId: args.expectedExchangeRateId,
      expectedProductVariantId: args.expectedProductVariantId,
    });

    return {
      isValid: true,
      transactionHash: args.transactionSignature,
      blockNumber: txResponse.slot.toString(),
      confirmations: 1,
      from: txRecord.walletAddress.toBase58(),
      to: args.programId.toBase58(),
      value: txRecord.amount.toString(),
      status: "success",
      gasUsed: (txResponse.meta?.fee ?? 0).toString(),
      blockTimestamp: (txResponse.blockTime ?? 0).toString(),
      chainId: 0,
    };
  }

  async verifyTransactionRecord(args: {
    blockchainId: string;
    programId: PublicKey;
    refId: string;
    refIdHash: Uint8Array;
    expectedWalletAddress: string;
    expectedTokenMint: string;
    expectedAmount: string;
    expectedBookingId: string;
    expectedExchangeRateId: string;
    expectedProductVariantId: string;
  }): Promise<TakumiPayTransactionRecord> {
    const { program } = this.getClient(args.blockchainId);
    const [configPda] = deriveConfigPda(args.programId);
    const [refRecordPda] = deriveRefRecordPda(
      args.programId,
      configPda,
      args.refIdHash,
    );

    const refRecord = await program.account.refRecord.fetch(refRecordPda);
    const txId = refRecord.recordId;
    const [txRecordPda] = deriveTxRecordPda(args.programId, configPda, txId);
    const txRecord = await program.account.transactionRecord.fetch(txRecordPda);

    if (txRecord.walletAddress.toBase58() !== args.expectedWalletAddress) {
      throw new Error(
        `Wallet address mismatch: expected ${args.expectedWalletAddress}, got ${txRecord.walletAddress.toBase58()}`,
      );
    }
    if (txRecord.tokenMint.toBase58() !== args.expectedTokenMint) {
      throw new Error("Token mint mismatch");
    }
    if (txRecord.amount.toString() !== args.expectedAmount) {
      throw new Error("Amount mismatch");
    }
    if (txRecord.bookingId !== args.expectedBookingId) {
      throw new Error("Booking ID mismatch");
    }
    if (txRecord.exchangeRateId.toString() !== args.expectedExchangeRateId) {
      throw new Error("Exchange rate ID mismatch");
    }
    if (txRecord.productVariantId !== args.expectedProductVariantId) {
      throw new Error("Product variant ID mismatch");
    }

    return txRecord;
  }

  async verifyMerchantPayment(args: {
    blockchainId: string;
    programId: PublicKey;
    refId: string;
    refIdHash: Uint8Array;
    expectedPayer: string;
    expectedMerchantId: string;
    expectedTokenMint: string;
    expectedAmount: string;
    expectedFiatAmountMinor: number;
    expectedFiatCurrency: string;
    expectedExchangeRateId: number;
  }): Promise<TakumiPayMerchantPayment> {
    const { program } = this.getClient(args.blockchainId);
    const [configPda] = deriveConfigPda(args.programId);
    const [merchantPaymentPda] = deriveMerchantPaymentPda(
      args.programId,
      configPda,
      args.refIdHash,
    );
    const mp = await program.account.merchantPayment.fetch(merchantPaymentPda);

    // Empty `expectedPayer` means the caller doesn't reliably know which of
    // the user's linked wallets signed this specific payment — same
    // convention as the Stellar/EVM branches; refId + merchantId + amount +
    // fiatAmount + exchangeRateId matching the backend-signed quote is the
    // real forgery guard.
    if (args.expectedPayer && mp.payer.toBase58() !== args.expectedPayer)
      throw new Error("Payer mismatch");
    if (mp.merchantId !== args.expectedMerchantId)
      throw new Error("Merchant ID mismatch");
    if (mp.tokenMint.toBase58() !== args.expectedTokenMint)
      throw new Error("Token mint mismatch");
    if (mp.amount.toString() !== args.expectedAmount)
      throw new Error("Amount mismatch");
    if (mp.fiatAmountMinor.toNumber() !== args.expectedFiatAmountMinor)
      throw new Error("Fiat amount mismatch");
    if (mp.exchangeRateId.toNumber() !== args.expectedExchangeRateId)
      throw new Error("Exchange rate ID mismatch");

    return mp;
  }

  async verifyPointDeposit(args: {
    blockchainId: string;
    programId: PublicKey;
    refId: string;
    refIdHash: Uint8Array;
    expectedWalletAddress: string;
    expectedTokenMint: string;
    expectedAmount: bigint;
  }): Promise<TakumiPayPointDepositRecord> {
    const { program } = this.getClient(args.blockchainId);
    const [configPda] = deriveConfigPda(args.programId);
    const [pointRefPda] = derivePointRefRecordPda(
      args.programId,
      configPda,
      args.refIdHash,
    );
    const refRecord = await program.account.refRecord.fetch(pointRefPda);
    const depositId = refRecord.recordId;
    const [depositPda] = derivePointDepositPda(
      args.programId,
      configPda,
      depositId,
    );
    const deposit = await program.account.pointDepositRecord.fetch(depositPda);

    if (deposit.walletAddress.toBase58() !== args.expectedWalletAddress)
      throw new Error("Wallet address mismatch");
    if (deposit.tokenMint.toBase58() !== args.expectedTokenMint)
      throw new Error("Token mint mismatch");
    if (BigInt(deposit.amount.toString()) !== args.expectedAmount)
      throw new Error("Amount mismatch");

    return deposit;
  }

  getSignerPublicKey(): string | null {
    return this.signerKeypair?.publicKey.toBase58() ?? null;
  }

  signMerchantQuote(params: MerchantQuoteParams): Uint8Array {
    if (!this.signerKeypair)
      throw new Error("Solana quote signer not configured");

    const message = this.buildQuoteMessage(params);
    return nacl.sign.detached(message, this.signerKeypair.secretKey);
  }

  private buildQuoteMessage(params: MerchantQuoteParams): Uint8Array {
    const parts: Uint8Array[] = [];

    const refIdBytes = new TextEncoder().encode(params.refId);
    const refIdLen = new Uint8Array(4);
    new DataView(refIdLen.buffer).setUint32(0, refIdBytes.length, true);
    parts.push(refIdLen, refIdBytes);

    const merchantIdBytes = new TextEncoder().encode(params.merchantId);
    const merchantIdLen = new Uint8Array(4);
    new DataView(merchantIdLen.buffer).setUint32(
      0,
      merchantIdBytes.length,
      true,
    );
    parts.push(merchantIdLen, merchantIdBytes);

    // token_mint placeholder (32 bytes of zeros for SOL, or actual mint bytes)
    parts.push(new Uint8Array(32));

    const u64le = (bn: BN) => {
      const buf = bn.toArrayLike(Buffer, "le", 8);
      return new Uint8Array(buf);
    };
    parts.push(u64le(params.amount));
    parts.push(u64le(params.platformFeeAmount));
    parts.push(u64le(params.fiatAmountMinor));
    parts.push(new Uint8Array(params.fiatCurrency));
    parts.push(u64le(params.exchangeRateId));

    const expiresAtBuf = params.expiresAt.toArrayLike(Buffer, "le", 8);
    parts.push(new Uint8Array(expiresAtBuf));

    const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
    const msg = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      msg.set(p, offset);
      offset += p.length;
    }
    return msg;
  }
}
