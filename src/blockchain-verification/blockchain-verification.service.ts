import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PublicKey } from "@solana/web3.js";
import {
  http,
  Chain,
  Hash,
  PublicClient,
  Transaction,
  TransactionReceipt,
  createPublicClient,
  parseEventLogs,
} from "viem";
import { readContract } from "viem/actions";
import { addressesEqual } from "../auth/address-compare";
import { assertChainFamily } from "../blockchains/chain-family";
import { resolveRpcEndpoint } from "../blockchains/rpc-endpoint";
import { getBlockchainConfig } from "../config/app.config";
import { PrismaService } from "../prisma/prisma.service";
import { TakumiPayAbi } from "./abis/takumi-pay.abi";
import { VerifyContractTransactionDto } from "./dto/verify-contract-transaction.dto";
import { SolanaVerificationService } from "./solana-verification.service";
import { computeRefIdHash } from "./solana/takumi-pay/ref-id-hash";
import { StellarVerificationService } from "./stellar-verification.service";
import {
  TTakumiWalletTransaction,
  TTransactionVerificationRequest,
  TTransactionVerificationResult,
} from "./types/blockchain-verification.types";

const TAKUMI_PAY_CONTRACT_NAME = "takumi_pay";

@Injectable()
export class BlockchainVerificationService {
  private readonly logger = new Logger(BlockchainVerificationService.name);
  private clients: Map<number, PublicClient> = new Map();
  private readonly minConfirmations: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly solanaVerification: SolanaVerificationService,
    private readonly stellarVerification: StellarVerificationService,
  ) {
    const blockchainConfig = getBlockchainConfig(this.configService);
    this.minConfirmations = blockchainConfig.minConfirmations;
    this.initializeClients();
  }

  /**
   * Rebuilds the viem client map from the DB. Public + idempotent so it
   * can be called both by the 5-minute safety-net cron below (same TTL
   * convention as `BlockchainCacheService`) and explicitly by
   * `BlockchainsService` right after a create/update/delete, instead of
   * requiring a process restart every time a chain is added — the exact
   * gap that let the Monad Testnet row sit invisible to point-deposit
   * verification after being seeded directly against the DB (Monad
   * Metropolis 2026 hackathon, 2026-09-17).
   */
  async refreshClients(): Promise<void> {
    await this.initializeClients();
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: "blockchain-verification-client-refresh",
  })
  private async refreshClientsCron() {
    await this.initializeClients();
  }

  private async initializeClients() {
    try {
      const blockchains = await this.prisma.blockchain.findMany({
        where: { isActive: true },
        include: {
          tokens: {
            where: {
              isNativeCurrency: true,
              isActive: true,
            },
          },
        },
      });

      // Rebuilt from scratch each call (not mutated in place) so a chain
      // that was deactivated or deleted since the last build also drops
      // out of the map here, not just newly-added ones.
      const nextClients: Map<number, PublicClient> = new Map();

      for (const blockchain of blockchains) {
        try {
          if (blockchain.type !== "EVM" || blockchain.chainId == null) {
            this.logger.log(
              `Skipping non-EVM blockchain ${blockchain.name} — viem client not applicable`,
            );
            continue;
          }

          const nativeToken = blockchain.tokens.find(
            (token) => token.isNativeCurrency,
          );

          // Chain-extension discipline: native decimals MUST come from the
          // seeded `tokens` row where `isNativeCurrency = true`. Arc's native
          // is USDC with decimals=6 — a hardcoded `18` fallback would silently
          // mis-format Arc balances on any viem helper that inspects
          // `chain.nativeCurrency.decimals`. If seed is incomplete, skip this
          // chain rather than register with fake decimals.
          // Spec ref: umkm-usdc-payout-spec.md §7.1 (ChainConfig audit).
          if (!nativeToken) {
            this.logger.warn(
              `Skipping chain ${blockchain.name} (chainId=${blockchain.chainId}): no active native-currency token row found; native decimals unknown.`,
            );
            continue;
          }

          // `rpcUrl` is an rpc-proxy route; resolve to an absolute URL and pick
          // up the proxy bearer (empty when the proxy runs without auth).
          const rpc = resolveRpcEndpoint(blockchain.rpcUrl);

          const dynamicChain: Chain = {
            id: blockchain.chainId,
            name: blockchain.name,
            nativeCurrency: {
              name: nativeToken.name,
              symbol: nativeToken.symbol,
              decimals: nativeToken.decimals,
            },
            rpcUrls: {
              default: {
                http: [rpc.url],
              },
              public: {
                http: [rpc.url],
              },
            },
            blockExplorers: blockchain.blockExplorer
              ? {
                  default: {
                    name: `${blockchain.name} Explorer`,
                    url: blockchain.blockExplorer,
                  },
                }
              : undefined,
            testnet: blockchain.isTestnet,
          };

          const client = createPublicClient({
            chain: dynamicChain,
            transport: http(rpc.url, {
              fetchOptions: { headers: rpc.headers },
            }),
          }) as PublicClient;

          nextClients.set(blockchain.chainId, client);

          this.logger.log(
            `Initialized dynamic client for chain ${blockchain.chainId} (${blockchain.name}) with native currency ${nativeToken.symbol} (decimals=${nativeToken.decimals})`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to initialize client for chain ${blockchain.chainId}: ${error.message}`,
          );
        }
      }

      this.clients = nextClients;
    } catch (error) {
      this.logger.error(
        `Failed to initialize blockchain clients from database: ${error.message}`,
      );
      // Leave the previous (possibly stale but working) `this.clients` in
      // place on a failed refresh — e.g. a transient DB hiccup during the
      // 5-minute cron tick — rather than wiping every chain's client out.
    }
  }

  private getClient(chainId: number): PublicClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw new BadRequestException(`Unsupported chain ID: ${chainId}`);
    }
    return client;
  }

  getPublicClient(chainId: number): PublicClient {
    return this.getClient(chainId);
  }

  /**
   * `takumi_pay`'s program/contract address per chain lives in
   * `SmartContract` (name: "takumi_pay"), the same per-chain contract
   * registry EVM's contracts already use — not a scalar column on
   * `Blockchain`. See the schema comment on `Blockchain.type` / the removed
   * `takumiPayProgramId` field for why: a dedicated column duplicated this
   * row with no sync guarantee.
   */
  private async requireTakumiPayContractAddress(blockchain: {
    id: string;
    name: string;
  }): Promise<string> {
    const contract = await this.prisma.smartContract.findFirst({
      where: {
        blockchainId: blockchain.id,
        name: TAKUMI_PAY_CONTRACT_NAME,
        isActive: true,
      },
    });
    if (!contract) {
      throw new BadRequestException(
        `Blockchain ${blockchain.name} (${blockchain.id}) has no active "${TAKUMI_PAY_CONTRACT_NAME}" SmartContract row configured`,
      );
    }
    return contract.address;
  }

  private async requireProgramId(blockchain: {
    id: string;
    name: string;
  }): Promise<PublicKey> {
    const address = await this.requireTakumiPayContractAddress(blockchain);
    return new PublicKey(address);
  }

  /**
   * Phase A — tx-receipt-level verification only.
   *
   * Waits for the transaction receipt with the required confirmations,
   * then validates: receipt status, chain ID, sender, recipient, and
   * confirmation count. Does NOT verify contract-level data (Phase B).
   *
   * Extracted from `verifyTransaction` (task 16) so that callers needing
   * only receipt-level checks (e.g. the onchain settlement provider) can
   * call this independently, while `verifyTransaction` continues to use
   * it internally before proceeding to Phase B.
   */
  async verifyTxReceiptOnly(args: {
    transactionHash: string;
    /** Empty = caller doesn't know the sender; the check is skipped. */
    expectedSender: string;
    expectedRecipient: string;
    expectedChainId: number;
    minimumConfirmations?: number;
  }): Promise<{
    receipt: TransactionReceipt;
    transaction: Transaction;
    confirmations: number;
  }> {
    const {
      transactionHash,
      expectedSender,
      expectedRecipient,
      expectedChainId,
      minimumConfirmations = this.minConfirmations,
    } = args;

    const client = this.getClient(expectedChainId);

    const receipt: TransactionReceipt = await client.waitForTransactionReceipt({
      hash: transactionHash as Hash,
      confirmations: minimumConfirmations,
      timeout: 60_000,
    });

    const transaction: Transaction = await client.getTransaction({
      hash: transactionHash as Hash,
    });

    const confirmations = await this.getTransactionConfirmations(
      transactionHash,
      expectedChainId,
    );

    if (receipt.status !== "success") {
      throw new BadRequestException(
        `Transaction ${transactionHash} was reverted or failed`,
      );
    }

    if (transaction.chainId !== expectedChainId) {
      throw new BadRequestException(
        `Chain ID mismatch: expected ${expectedChainId}, got ${transaction.chainId}`,
      );
    }

    if (
      expectedSender &&
      transaction.from.toLowerCase() !== expectedSender.toLowerCase()
    ) {
      throw new BadRequestException(
        `Sender address mismatch: expected ${expectedSender}, got ${transaction.from}`,
      );
    }

    if (transaction.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
      throw new BadRequestException(
        `Recipient address mismatch: expected ${expectedRecipient}, got ${transaction.to}`,
      );
    }

    if (confirmations < minimumConfirmations) {
      throw new BadRequestException(
        `Insufficient confirmations: ${confirmations}/${minimumConfirmations}`,
      );
    }

    return { receipt, transaction, confirmations };
  }

  async verifyTransaction(
    request: TTransactionVerificationRequest,
  ): Promise<TTransactionVerificationResult> {
    const {
      transactionHash,
      expectedSender,
      expectedRecipient,
      expectedChainId,
      minimumConfirmations = this.minConfirmations,
    } = request;

    this.logger.log(
      `Verifying transaction ${transactionHash} on chain ${expectedChainId}`,
    );

    try {
      const blockchain = await this.prisma.blockchain.findUnique({
        where: { id: request.blockchainId },
      });
      if (blockchain && blockchain.type !== "EVM") {
        const family = assertChainFamily(blockchain.type, blockchain.name);
        if (family === "SVM") {
          const programId = await this.requireProgramId(blockchain);
          const refIdHash = computeRefIdHash(request.refId);
          return this.solanaVerification.verifyTransaction({
            blockchainId: request.blockchainId,
            programId,
            transactionSignature: transactionHash,
            refId: request.refId,
            refIdHash,
            expectedWalletAddress: expectedSender,
            expectedTokenMint: request.expectedTokenAddress,
            expectedAmount: request.expectedAmount,
            expectedBookingId: request.expectedBookingId,
            expectedExchangeRateId: request.expectedExchangeRateId,
            expectedProductVariantId: request.expectedProductVariantId,
          });
        }
        if (family === "STELLAR") {
          return this.stellarVerification.verifyTransaction({
            blockchainId: request.blockchainId,
            transactionHash,
            refId: request.refId,
            expectedWalletAddress: expectedSender,
            expectedTokenAddress: request.expectedTokenAddress,
            expectedAmount: request.expectedAmount,
            expectedBookingId: request.expectedBookingId,
            expectedExchangeRateId: request.expectedExchangeRateId,
            expectedProductVariantId: request.expectedProductVariantId,
          });
        }
        throw new BadRequestException(
          `Unsupported chain family for blockchain ${blockchain.name} (chainSlug=${blockchain.chainSlug})`,
        );
      }

      // Phase A — tx-receipt checks (delegated to verifyTxReceiptOnly)
      const { receipt, transaction, confirmations } =
        await this.verifyTxReceiptOnly({
          transactionHash,
          expectedSender,
          expectedRecipient,
          expectedChainId,
          minimumConfirmations,
        });

      const client = this.getClient(expectedChainId);
      const currentBlock = await client.getBlock({
        blockTag: "latest",
      });

      const result: TTransactionVerificationResult = {
        isValid: true,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        confirmations,
        from: transaction.from,
        to: transaction.to ?? "",
        value: transaction.value.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        blockTimestamp: currentBlock.timestamp.toString(),
        chainId: transaction.chainId || expectedChainId,
      };

      this.logger.log(
        `Transaction ${transactionHash} verified successfully with ${confirmations} confirmations`,
      );

      // Phase B — contract-level verification
      const record = await this.verifyTransactionInContract({
        refId: request.refId,
        contractAddress: request.contractAddress,
        chainId: expectedChainId,
        expectedWalletAddress: transaction.from,
        expectedTokenAddress: request.expectedTokenAddress,
        expectedAmount: request.expectedAmount,
        expectedBookingId: request.expectedBookingId,
        expectedExchangeRateId: request.expectedExchangeRateId,
        expectedProductVariantId: request.expectedProductVariantId,
      });
      this.logger.log(
        `Contract verification successful for refId ${request.refId}`,
      );
      result.recordTimestamp = record.timestamp.toString();

      return result;
    } catch (error) {
      this.logger.error(
        `Transaction verification failed: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to verify transaction ${transactionHash}: ${error.message}`,
      );
    }
  }

  async isTransactionConfirmed(
    transactionHash: string,
    chainId: number,
    minimumConfirmations: number = this.minConfirmations,
  ): Promise<boolean> {
    try {
      const client = this.getClient(chainId);

      const receipt = await client.getTransactionReceipt({
        hash: transactionHash as Hash,
      });

      if (!receipt) {
        return false;
      }

      const currentBlockNumber = await client.getBlockNumber();
      const confirmations =
        Number(currentBlockNumber) - Number(receipt.blockNumber);

      return (
        confirmations >= minimumConfirmations && receipt.status === "success"
      );
    } catch (error) {
      this.logger.error(
        `Error checking transaction confirmation: ${error.message}`,
      );
      return false;
    }
  }

  async getTransactionConfirmations(
    transactionHash: string,
    chainId: number,
  ): Promise<number> {
    try {
      const client = this.getClient(chainId);

      const receipt = await client.getTransactionReceipt({
        hash: transactionHash as Hash,
      });

      if (!receipt) {
        return 0;
      }

      const currentBlockNumber = await client.getBlockNumber();
      return Number(currentBlockNumber - receipt.blockNumber) + 1;
    } catch (error) {
      this.logger.error(
        `Error getting transaction confirmations: ${error.message}`,
      );
      return 0;
    }
  }

  async verifyTransactionInContract(
    trxData: VerifyContractTransactionDto,
    blockchainId?: string,
  ): Promise<TTakumiWalletTransaction> {
    try {
      // Solana dispatch: if a blockchainId is provided, check whether the
      // blockchain is non-EVM and route to the Solana verification service.
      if (blockchainId) {
        const blockchain = await this.prisma.blockchain.findUnique({
          where: { id: blockchainId },
        });
        if (blockchain && blockchain.type !== "EVM") {
          const family = assertChainFamily(blockchain.type, blockchain.name);
          if (family === "SVM") {
            const programId = await this.requireProgramId(blockchain);
            const refIdHash = computeRefIdHash(trxData.refId);
            const solanaRecord =
              await this.solanaVerification.verifyTransactionRecord({
                blockchainId,
                programId,
                refId: trxData.refId,
                refIdHash,
                expectedWalletAddress: trxData.expectedWalletAddress,
                expectedTokenMint: trxData.expectedTokenAddress,
                expectedAmount: trxData.expectedAmount,
                expectedBookingId: trxData.expectedBookingId,
                expectedExchangeRateId: trxData.expectedExchangeRateId,
                expectedProductVariantId: trxData.expectedProductVariantId,
              });
            return {
              walletAddress: solanaRecord.walletAddress.toBase58(),
              tokenAddress: solanaRecord.tokenMint.toBase58(),
              bookingId: solanaRecord.bookingId,
              exchangeRateId: BigInt(solanaRecord.exchangeRateId.toString()),
              productVariantId: solanaRecord.productVariantId,
              timestamp: BigInt(solanaRecord.timestamp.toString()),
              refId: solanaRecord.refId,
              amount: BigInt(solanaRecord.amount.toString()),
            };
          }
          if (family === "STELLAR") {
            throw new BadRequestException(
              "Stellar transaction-record verification requires a transaction hash (use verifyTransaction), not a direct ref-only lookup — get_transaction is keyed by numeric tx_id, not ref_id.",
            );
          }
          throw new BadRequestException(
            `Unsupported chain family for blockchain ${blockchain.name} (chainSlug=${blockchain.chainSlug})`,
          );
        }
      }

      this.logger.log(
        `Verifying transaction in contract ${trxData.contractAddress} for refId ${trxData.refId} on chain ${trxData.chainId}`,
      );

      const client = this.getClient(trxData.chainId);
      const readRecord = () =>
        readContract(client, {
          address: trxData.contractAddress as `0x${string}`,
          abi: TakumiPayAbi,
          functionName: "getTransactionByRef",
          args: [trxData.refId],
        });
      let contractTransaction = await readRecord();
      // The receipt is already in (Phase A), but `eth_call` at "latest" can
      // land on an upstream that has not imported that block and answer with
      // an empty struct. A few short retries absorb that lag.
      for (
        let attempt = 0;
        attempt < 3 && contractTransaction.refId === "";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        contractTransaction = await readRecord();
      }
      if (contractTransaction.refId === "") {
        // Deliberately not worded "mismatch": an absent record is "not
        // visible yet" until proven otherwise, which the settlement policy
        // retries silently, instead of a chain verdict that fails the order.
        throw new BadRequestException(
          `Contract has no record for refId ${trxData.refId} yet`,
        );
      }

      const transaction: TTakumiWalletTransaction = {
        walletAddress: contractTransaction.walletAddress,
        tokenAddress: contractTransaction.tokenAddress,
        bookingId: contractTransaction.bookingId,
        exchangeRateId: contractTransaction.exchangeRateId,
        productVariantId: contractTransaction.productVariantId,
        timestamp: contractTransaction.timestamp,
        refId: contractTransaction.refId,
        amount: contractTransaction.amount,
      };

      if (transaction.refId !== trxData.refId) {
        throw new BadRequestException(
          `Contract refId mismatch: expected ${trxData.refId}, got ${transaction.refId}`,
        );
      }

      // EVM-only: both addresses come from viem (0x hex).
      if (
        !addressesEqual(
          transaction.walletAddress,
          trxData.expectedWalletAddress,
        )
      ) {
        throw new BadRequestException(
          `Contract wallet address mismatch: expected ${trxData.expectedWalletAddress}, got ${transaction.walletAddress}`,
        );
      }

      // Strict, always. The contract records address(0) for native payments,
      // so a native booking expects the zero address and nothing else. There
      // is deliberately no "native" shortcut: treating an expected token equal
      // to the contract address as native used to skip this check entirely, so
      // a buyer could book in a 6-decimal stablecoin and pay the same raw
      // amount in another allowed token (or native) with 18 decimals.
      if (
        transaction.tokenAddress.toLowerCase() !==
        trxData.expectedTokenAddress.toLowerCase()
      ) {
        throw new BadRequestException(
          `Contract token address mismatch: expected ${trxData.expectedTokenAddress}, got ${transaction.tokenAddress}`,
        );
      }

      if (transaction.amount.toString() !== trxData.expectedAmount) {
        throw new BadRequestException(
          `Contract amount mismatch: expected ${trxData.expectedAmount}, got ${transaction.amount.toString()}`,
        );
      }

      if (
        trxData.expectedBookingId &&
        transaction.bookingId !== trxData.expectedBookingId
      ) {
        throw new BadRequestException(
          `Contract bookingId mismatch: expected ${trxData.expectedBookingId}, got ${transaction.bookingId}`,
        );
      }

      if (
        trxData.expectedExchangeRateId &&
        Number(transaction.exchangeRateId) !==
          Number(trxData.expectedExchangeRateId)
      ) {
        throw new BadRequestException(
          `Contract exchangeRateId mismatch: expected ${trxData.expectedExchangeRateId}, got ${transaction.exchangeRateId}`,
        );
      }

      if (
        trxData.expectedProductVariantId &&
        transaction.productVariantId !== trxData.expectedProductVariantId
      ) {
        throw new BadRequestException(
          `Contract productVariantId mismatch: expected ${trxData.expectedProductVariantId}, got ${transaction.productVariantId}`,
        );
      }

      this.logger.log(
        `Contract verification successful: refId=${transaction.refId}, wallet=${transaction.walletAddress}, amount=${transaction.amount.toString()}, bookingId=${transaction.bookingId}, exchangeRateId=${transaction.exchangeRateId}, productVariantId=${transaction.productVariantId}`,
      );

      return transaction;
    } catch (error) {
      this.logger.error(
        `Contract verification failed for refId ${trxData.refId}: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to verify transaction in contract: ${error.message}`,
      );
    }
  }

  /**
   * Phase A for an EVM merchant payment: wait for the submitted tx to reach
   * the chain's required confirmations, check it succeeded and was sent to
   * the `takumi_pay` contract, then bind it to THIS intent by finding the
   * `MerchantPaymentProcessed` log the contract emitted for `refId` in the
   * receipt. Returns the payer that log names so Phase B
   * (`verifyMerchantPaymentInContract`) can pin the on-chain record to the
   * wallet that actually paid — no server-side guess about which of the
   * user's linked wallets signed.
   *
   * Without the log check, any successful tx to the contract (e.g. the same
   * payer's payment for a different intent) would pass Phase A and Phase B
   * would still find this refId's record, so the wrong txHash would be
   * stored against the settlement. The log is what proves "this tx is the
   * one that paid this intent".
   *
   * Throws viem's `WaitForTransactionReceiptTimeoutError` (name preserved)
   * if the receipt doesn't arrive within the timeout — callers treat that
   * as in-flight, not as a rejection.
   */
  async verifyMerchantPaymentTx(args: {
    txHash: string;
    chainId: number;
    contractAddress: string;
    refId: string;
    minimumConfirmations?: number;
  }): Promise<{ payer: string; confirmations: number }> {
    const { receipt, confirmations } = await this.verifyTxReceiptOnly({
      transactionHash: args.txHash,
      expectedSender: "",
      expectedRecipient: args.contractAddress,
      expectedChainId: args.chainId,
      minimumConfirmations: args.minimumConfirmations,
    });

    const contractLower = args.contractAddress.toLowerCase();
    const processed = parseEventLogs({
      abi: TakumiPayAbi,
      eventName: "MerchantPaymentProcessed",
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() === contractLower,
      ),
    }).find((log) => log.args.refId === args.refId);

    if (!processed) {
      throw new BadRequestException(
        `Transaction ${args.txHash} did not process merchant payment ${args.refId}`,
      );
    }

    return { payer: processed.args.payer, confirmations };
  }

  /**
   * Verify a merchant payment in the TakumiWalletMerchant contract (task 17).
   *
   * Calls `readContract` with `getMerchantPaymentByRef(refId)` on the
   * merchant contract ABI and compares all returned fields against the
   * expected values from the DB. Throws `BadRequestException` with a
   * specific message on any mismatch.
   *
   * The MerchantPayment struct returned by the contract:
   *   payer, tokenAddress, merchantId, refId, amount, platformFeeAmount,
   *   fiatAmountMinor, fiatCurrency, exchangeRateId, timestamp.
   */
  async verifyMerchantPaymentInContract(args: {
    contractAddress: string;
    chainId: number;
    refId: string;
    expectedPayer: string;
    expectedMerchantId: string;
    expectedTokenAddress: string;
    expectedAmount: string;
    expectedFiatAmountMinor: number;
    expectedFiatCurrency: string;
    expectedExchangeRateId: number;
    blockchainId?: string;
    /**
     * Solana only: the submitted signature. When present the record read
     * waits for it to reach `confirmed` first, so a submit that races the
     * cluster doesn't fail with "account does not exist".
     */
    txHash?: string;
  }): Promise<void> {
    try {
      // Solana dispatch: route to Solana verification for non-EVM blockchains.
      if (args.blockchainId) {
        const blockchain = await this.prisma.blockchain.findUnique({
          where: { id: args.blockchainId },
        });
        if (blockchain && blockchain.type !== "EVM") {
          const family = assertChainFamily(blockchain.type, blockchain.name);
          if (family === "SVM") {
            const programId = await this.requireProgramId(blockchain);
            const refIdHash = computeRefIdHash(args.refId);
            if (args.txHash) {
              await this.solanaVerification.waitForConfirmation(
                args.blockchainId,
                args.txHash,
                "confirmed",
              );
            }
            await this.solanaVerification.verifyMerchantPayment({
              blockchainId: args.blockchainId,
              programId,
              refId: args.refId,
              refIdHash,
              expectedPayer: args.expectedPayer,
              expectedMerchantId: args.expectedMerchantId,
              expectedTokenMint: args.expectedTokenAddress,
              expectedAmount: args.expectedAmount,
              expectedFiatAmountMinor: args.expectedFiatAmountMinor,
              expectedFiatCurrency: args.expectedFiatCurrency,
              expectedExchangeRateId: args.expectedExchangeRateId,
            });
            return;
          }
          if (family === "STELLAR") {
            await this.stellarVerification.verifyMerchantPayment({
              blockchainId: args.blockchainId,
              refId: args.refId,
              expectedPayer: args.expectedPayer,
              expectedMerchantId: args.expectedMerchantId,
              expectedTokenAddress: args.expectedTokenAddress,
              expectedAmount: args.expectedAmount,
              expectedFiatAmountMinor: args.expectedFiatAmountMinor,
              expectedFiatCurrency: args.expectedFiatCurrency,
              expectedExchangeRateId: args.expectedExchangeRateId,
            });
            return;
          }
          throw new BadRequestException(
            `Unsupported chain family for blockchain ${blockchain.name} (chainSlug=${blockchain.chainSlug})`,
          );
        }
      }

      this.logger.log(
        `Verifying merchant payment in contract ${args.contractAddress} for refId ${args.refId} on chain ${args.chainId}`,
      );

      const client = this.getClient(args.chainId);
      const readPayment = () =>
        readContract(client, {
          address: args.contractAddress as `0x${string}`,
          abi: TakumiPayAbi,
          functionName: "getMerchantPaymentByRef",
          args: [args.refId],
        });

      // The caller has already seen the receipt (Phase A), but `eth_call`
      // at "latest" may land on a proxy upstream that hasn't imported that
      // block yet and answer with an empty struct. A few short retries
      // absorb that lag; a genuinely missing record still fails below.
      let payment = await readPayment();
      for (let attempt = 0; attempt < 3 && payment.refId === ""; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        payment = await readPayment();
      }

      if (payment.refId !== args.refId) {
        throw new BadRequestException(
          `Merchant payment refId mismatch: expected ${args.refId}, got ${payment.refId}`,
        );
      }

      // A user may pay from any of their linked wallets, so the caller
      // (`IntentsService.submitOnchain`) intentionally passes an empty
      // `expectedPayer` when it doesn't reliably know which one signed
      // this specific payment — same convention as the Stellar branch's
      // `verifyMerchantPayment`. refId + merchantId + amount + fiatAmount
      // + exchangeRateId matching the backend-signed quote is the real
      // forgery guard; skip this check rather than false-reject.
      if (
        args.expectedPayer &&
        !addressesEqual(payment.payer, args.expectedPayer)
      ) {
        throw new BadRequestException(
          `Merchant payment payer mismatch: expected ${args.expectedPayer}, got ${payment.payer}`,
        );
      }

      if (payment.merchantId !== args.expectedMerchantId) {
        throw new BadRequestException(
          `Merchant payment merchantId mismatch: expected ${args.expectedMerchantId}, got ${payment.merchantId}`,
        );
      }

      // Handle native token sentinel: address(0) represents native currency
      const isNativeToken =
        args.expectedTokenAddress ===
          "0x0000000000000000000000000000000000000000" ||
        args.expectedTokenAddress.toLowerCase() ===
          args.contractAddress.toLowerCase();

      if (
        !isNativeToken &&
        payment.tokenAddress.toLowerCase() !==
          args.expectedTokenAddress.toLowerCase()
      ) {
        throw new BadRequestException(
          `Merchant payment tokenAddress mismatch: expected ${args.expectedTokenAddress}, got ${payment.tokenAddress}`,
        );
      }

      if (payment.amount.toString() !== args.expectedAmount) {
        throw new BadRequestException(
          `Merchant payment amount mismatch: expected ${args.expectedAmount}, got ${payment.amount.toString()}`,
        );
      }

      if (Number(payment.fiatAmountMinor) !== args.expectedFiatAmountMinor) {
        throw new BadRequestException(
          `Merchant payment fiatAmountMinor mismatch: expected ${args.expectedFiatAmountMinor}, got ${payment.fiatAmountMinor}`,
        );
      }

      if (Number(payment.exchangeRateId) !== args.expectedExchangeRateId) {
        throw new BadRequestException(
          `Merchant payment exchangeRateId mismatch: expected ${args.expectedExchangeRateId}, got ${payment.exchangeRateId}`,
        );
      }

      this.logger.log(
        `Merchant payment contract verification successful: refId=${payment.refId}, payer=${payment.payer}, amount=${payment.amount.toString()}, merchantId=${payment.merchantId}`,
      );
    } catch (error) {
      this.logger.error(
        `Merchant payment contract verification failed for refId ${args.refId}: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to verify merchant payment in contract: ${error.message}`,
      );
    }
  }

  /**
   * Verify a point deposit transaction on-chain.
   * 1. Waits for the tx receipt with the required confirmations.
   * 2. Reads the PointDeposit contract's getTransactionByRef(refId).
   * 3. Validates the returned deposit data against expected values.
   */
  async verifyPointDeposit(params: {
    txHash: string;
    chainId: number;
    contractAddress: string;
    refId: string;
    expectedWalletAddress: string;
    expectedTokenAddress: string;
    expectedAmount: bigint;
    minConfirmations?: number;
    blockchainId?: string;
  }): Promise<{ walletAddress: string; tokenAddress: string; amount: bigint }> {
    const {
      txHash,
      chainId,
      contractAddress,
      refId,
      expectedWalletAddress,
      expectedTokenAddress,
      expectedAmount,
      minConfirmations = 12,
    } = params;

    // Non-EVM dispatch: route to the matching chain family's verification
    // service (Solana / Stellar) for non-EVM blockchains.
    if (params.blockchainId) {
      const blockchain = await this.prisma.blockchain.findUnique({
        where: { id: params.blockchainId },
      });
      if (blockchain && blockchain.type !== "EVM") {
        const family = assertChainFamily(blockchain.type, blockchain.name);
        if (family === "SVM") {
          const programId = await this.requireProgramId(blockchain);
          const refIdHash = computeRefIdHash(refId);
          const deposit = await this.solanaVerification.verifyPointDeposit({
            blockchainId: params.blockchainId,
            programId,
            refId,
            refIdHash,
            expectedWalletAddress,
            expectedTokenMint: expectedTokenAddress,
            expectedAmount,
          });
          return {
            walletAddress: deposit.walletAddress.toBase58(),
            tokenAddress: deposit.tokenMint.toBase58(),
            amount: BigInt(deposit.amount.toString()),
          };
        }
        if (family === "STELLAR") {
          const deposit = await this.stellarVerification.verifyPointDeposit({
            blockchainId: params.blockchainId,
            transactionHash: txHash,
            refId,
            expectedWalletAddress,
            expectedTokenAddress,
            expectedAmount,
          });
          return {
            walletAddress: deposit.walletAddress,
            tokenAddress: deposit.token,
            amount: deposit.amount,
          };
        }
        throw new BadRequestException(
          `Unsupported chain family for blockchain ${blockchain.name} (chainSlug=${blockchain.chainSlug})`,
        );
      }
    }

    this.logger.log(
      `Verifying point deposit tx ${txHash} on chain ${chainId} for refId ${refId}`,
    );

    try {
      const client = this.getClient(chainId);

      const receipt = await client.waitForTransactionReceipt({
        hash: txHash as Hash,
        confirmations: minConfirmations,
        timeout: 60_000,
      });

      if (receipt.status !== "success") {
        throw new BadRequestException(
          `Point deposit transaction ${txHash} was reverted or failed`,
        );
      }

      const contractTx = await readContract(client, {
        address: contractAddress as `0x${string}`,
        abi: TakumiPayAbi,
        functionName: "getPointDepositByRef",
        args: [refId],
      });

      // EVM-only: viem contract read returns 0x hex addresses.
      if (!addressesEqual(contractTx.walletAddress, expectedWalletAddress)) {
        throw new BadRequestException(
          `Point deposit wallet mismatch: expected ${expectedWalletAddress}, got ${contractTx.walletAddress}`,
        );
      }

      if (
        contractTx.tokenAddress.toLowerCase() !==
        expectedTokenAddress.toLowerCase()
      ) {
        throw new BadRequestException(
          `Point deposit token mismatch: expected ${expectedTokenAddress}, got ${contractTx.tokenAddress}`,
        );
      }

      if (contractTx.amount !== expectedAmount) {
        throw new BadRequestException(
          `Point deposit amount mismatch: expected ${expectedAmount}, got ${contractTx.amount}`,
        );
      }

      this.logger.log(
        `Point deposit verified: refId=${refId}, wallet=${contractTx.walletAddress}, amount=${contractTx.amount}`,
      );

      return {
        walletAddress: contractTx.walletAddress,
        tokenAddress: contractTx.tokenAddress,
        amount: contractTx.amount,
      };
    } catch (error) {
      this.logger.error(
        `Point deposit verification failed for refId ${refId}: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to verify point deposit: ${error.message}`,
      );
    }
  }
}
