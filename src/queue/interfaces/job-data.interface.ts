export interface TPurchaseJobData {
  refId: string;
  bookingId: string;
  walletAddress: string;
  networkId: string;
  contractAddress: string;
  transactionHash: string;
  userId: string;
  tokenId: string;
  purchaseId: string;
  /**
   * Written by the worker via `job.updateData`, never by the producer. The
   * post-payment stage has its own small retry budget, separate from the
   * job's long verification budget, so its count lives here.
   */
  vendorAttempts?: number;
  /** Whether `createOrder` was reached on an earlier attempt. */
  vendorOrderAttempted?: boolean;
}

export interface TBlockchainVerificationJobData {
  refId: string;
  transactionHash: string;
  expectedSender: string;
  expectedRecipient: string;
  expectedChainId: number;
  minimumConfirmations: number;
  purchaseId?: string;
}

export interface TVendorApiJobData {
  refId: string;
  purchaseId: string;
  vendorName: string;
  brandKey: string;
  variationKey: string;
  price: number;
  formData: Array<{ key: string; value: string }>;
  bookingId: string;
}


export interface TPurchaseStatusUpdate {
  refId: string;
  purchaseId?: string;
  status:
    | "processing"
    | "pending"
    | "blockchain_verifying"
    | "blockchain_verified"
    | "vendor_processing"
    | "completed"
    | "failed";
  stage: string;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
