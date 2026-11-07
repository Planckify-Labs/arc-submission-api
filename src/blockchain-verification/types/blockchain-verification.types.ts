export interface TTakumiWalletTransaction {
  walletAddress: string;
  tokenAddress: string;
  bookingId: string;
  exchangeRateId: bigint;
  productVariantId: string;
  timestamp: bigint;
  refId: string;
  amount: bigint;
}

export interface TTransactionVerificationResult {
  isValid: boolean;
  transactionHash: string;
  blockNumber: string;
  confirmations: number;
  from: string;
  to: string;
  value: string;
  status: "success" | "reverted";
  gasUsed: string;
  /** Timestamp of the LATEST block, not of the payment. Do not use it to date a payment. */
  blockTimestamp: string;
  chainId: number;
  /**
   * Unix seconds at which the contract recorded THIS payment
   * (`block.timestamp` of the paying tx). EVM only; absent otherwise.
   * This is the one to judge "paid in time" by.
   */
  recordTimestamp?: string;
}

export interface TTransactionVerificationRequest {
  transactionHash: string;
  expectedSender: string;
  /** The contract the tx must be sent to (EVM `tx.to`). NOT the token. */
  expectedRecipient: string;
  /**
   * The token the buyer booked in (`booking.payment.tokenAddress`; the zero
   * address for a chain's native currency). Compared against the token the
   * contract recorded. Kept apart from `expectedRecipient` on purpose: using
   * the contract address as the token made the check a no-op.
   */
  expectedTokenAddress: string;
  expectedChainId: number;
  minimumConfirmations?: number;
  refId: string;
  contractAddress: string;
  expectedBookingId: string;
  expectedExchangeRateId: string;
  expectedProductVariantId: string;
  expectedAmount: string;
  blockchainId: string;
}
