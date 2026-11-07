import { readContract } from "viem/actions";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import { BlockchainVerificationService } from "./blockchain-verification.service";
import { SolanaVerificationService } from "./solana-verification.service";
import { StellarVerificationService } from "./stellar-verification.service";
import type { TTransactionVerificationResult } from "./types/blockchain-verification.types";

jest.mock("viem/actions", () => ({ readContract: jest.fn() }));

const SOLANA_BLOCKCHAIN_ID = "blockchain_solana_devnet";
const STELLAR_BLOCKCHAIN_ID = "blockchain_stellar_testnet";
const EVM_BLOCKCHAIN_ID = "blockchain_polygon";
const SUI_BLOCKCHAIN_ID = "blockchain_sui_testnet";
const EVM_CHAIN_ID = 137;
const CUSTOM_PROGRAM_ID = "CuStomProgram1111111111111111111111111111111";
const CUSTOM_CONTRACT_ID = "CCLFTLVPHOKKDZYTMGU6UNXKFEN6VF3QVYEAJNULGIC7ZXTETAIPKKRZ";

const baseRequest = {
  transactionHash: "5WbxpNm8...",
  expectedSender: "SenderAddr",
  expectedRecipient: "RecipientAddr",
  expectedTokenAddress: "BookedTokenAddr",
  expectedChainId: 0,
  refId: "ref_001",
  contractAddress: "ContractAddr",
  expectedBookingId: "booking_001",
  expectedExchangeRateId: "42",
  expectedProductVariantId: "variant_001",
  expectedAmount: "1000000",
};

const solanaResult: TTransactionVerificationResult = {
  isValid: true,
  transactionHash: "5WbxpNm8...",
  blockNumber: "123456",
  confirmations: 1,
  from: "SenderAddr",
  to: "ProgramId",
  value: "1000000",
  status: "success",
  gasUsed: "5000",
  blockTimestamp: "1700000000",
  chainId: 0,
};

const stellarResult: TTransactionVerificationResult = {
  isValid: true,
  transactionHash: "d36b93cda1...",
  blockNumber: "3562633",
  confirmations: 1,
  from: "SenderAddr",
  to: CUSTOM_CONTRACT_ID,
  value: "1000000",
  status: "success",
  gasUsed: "0",
  blockTimestamp: "1783829403",
  chainId: 0,
};

function makePrismaStub() {
  const blockchainRows: Record<string, unknown> = {
    [SOLANA_BLOCKCHAIN_ID]: {
      id: SOLANA_BLOCKCHAIN_ID,
      name: "Solana Devnet",
      isActive: true,
      chainSlug: "solana-devnet",
      type: "SVM",
    },
    [STELLAR_BLOCKCHAIN_ID]: {
      id: STELLAR_BLOCKCHAIN_ID,
      name: "Stellar Testnet",
      isActive: true,
      chainSlug: "stellar-testnet",
      type: "STELLAR",
    },
    [EVM_BLOCKCHAIN_ID]: {
      id: EVM_BLOCKCHAIN_ID,
      name: "Polygon",
      isActive: true,
      chainId: EVM_CHAIN_ID,
      chainSlug: null,
      type: "EVM",
    },
    [SUI_BLOCKCHAIN_ID]: {
      id: SUI_BLOCKCHAIN_ID,
      name: "Sui Testnet",
      isActive: true,
      chainSlug: "sui-testnet",
      type: "MOVE_VM",
    },
  };

  // `takumi_pay`'s address now lives in SmartContract (name: "takumi_pay"),
  // not a scalar column on the blockchain row — see
  // BlockchainVerificationService.requireTakumiPayContractAddress.
  const smartContractRows: Record<string, { address: string } | undefined> = {
    [SOLANA_BLOCKCHAIN_ID]: { address: CUSTOM_PROGRAM_ID },
    [STELLAR_BLOCKCHAIN_ID]: { address: CUSTOM_CONTRACT_ID },
  };

  return {
    blockchain: {
      findUnique: jest.fn(({ where }) => Promise.resolve(blockchainRows[where.id] ?? null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    smartContract: {
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(smartContractRows[where.blockchainId] ?? null),
      ),
    },
  };
}

function makeSolanaStub() {
  return {
    verifyTransaction: jest.fn(async () => solanaResult),
    verifyTransactionRecord: jest.fn(),
    verifyMerchantPayment: jest.fn(),
    verifyPointDeposit: jest.fn(),
  } as unknown as jest.Mocked<SolanaVerificationService>;
}

function makeStellarStub() {
  return {
    verifyTransaction: jest.fn(async () => stellarResult),
    verifyTransactionRecord: jest.fn(),
    verifyMerchantPayment: jest.fn(),
    verifyPointDeposit: jest.fn(),
  } as unknown as jest.Mocked<StellarVerificationService>;
}

function makeConfigStub() {
  return {
    get: jest.fn((key: string, defaultVal?: unknown) => {
      if (key === "MIN_CONFIRMATIONS") return 12;
      return defaultVal;
    }),
  };
}

function buildService() {
  const prisma = makePrismaStub();
  const solana = makeSolanaStub();
  const stellar = makeStellarStub();
  const config = makeConfigStub();

  const svc = new BlockchainVerificationService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    solana as unknown as SolanaVerificationService,
    stellar as unknown as StellarVerificationService,
  );

  return { svc, prisma, solana, stellar };
}

describe("BlockchainVerificationService.verifyTransaction routing", () => {
  it("dispatches to SolanaVerificationService when blockchain is non-EVM", async () => {
    const { svc, solana, prisma } = buildService();

    const result = await svc.verifyTransaction({
      ...baseRequest,
      blockchainId: SOLANA_BLOCKCHAIN_ID,
    });

    expect(result).toBe(solanaResult);
    expect(solana.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(solana.verifyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        blockchainId: SOLANA_BLOCKCHAIN_ID,
        transactionSignature: baseRequest.transactionHash,
        refId: baseRequest.refId,
        expectedWalletAddress: baseRequest.expectedSender,
        expectedTokenMint: baseRequest.expectedTokenAddress,
        expectedAmount: baseRequest.expectedAmount,
        expectedBookingId: baseRequest.expectedBookingId,
        expectedExchangeRateId: baseRequest.expectedExchangeRateId,
        expectedProductVariantId: baseRequest.expectedProductVariantId,
      }),
    );
    expect(prisma.blockchain.findUnique).toHaveBeenCalledWith({
      where: { id: SOLANA_BLOCKCHAIN_ID },
    });
  });

  it("does NOT dispatch to Solana when blockchain is EVM", async () => {
    const { svc, solana } = buildService();

    await expect(
      svc.verifyTransaction({
        ...baseRequest,
        expectedChainId: EVM_CHAIN_ID,
        blockchainId: EVM_BLOCKCHAIN_ID,
      }),
    ).rejects.toThrow(/Unsupported chain ID/);

    expect(solana.verifyTransaction).not.toHaveBeenCalled();
  });

  it("resolves the program id from the takumi_pay SmartContract row", async () => {
    const { svc, solana, prisma } = buildService();

    await svc.verifyTransaction({
      ...baseRequest,
      blockchainId: SOLANA_BLOCKCHAIN_ID,
    });

    const call = solana.verifyTransaction.mock.calls[0][0];
    expect(call.programId.toBase58()).toBe(CUSTOM_PROGRAM_ID);
    expect(prisma.smartContract.findFirst).toHaveBeenCalledWith({
      where: { blockchainId: SOLANA_BLOCKCHAIN_ID, name: "takumi_pay", isActive: true },
    });
  });

  it("throws when non-EVM blockchain has no active takumi_pay SmartContract row", async () => {
    const { svc, solana, prisma } = buildService();

    (prisma.smartContract.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      svc.verifyTransaction({
        ...baseRequest,
        blockchainId: SOLANA_BLOCKCHAIN_ID,
      }),
    ).rejects.toThrow(/has no active "takumi_pay" SmartContract row configured/);

    expect(solana.verifyTransaction).not.toHaveBeenCalled();
  });

  it("dispatches to StellarVerificationService when blockchain is Stellar", async () => {
    const { svc, stellar } = buildService();

    const result = await svc.verifyTransaction({
      ...baseRequest,
      blockchainId: STELLAR_BLOCKCHAIN_ID,
    });

    expect(result).toBe(stellarResult);
    expect(stellar.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(stellar.verifyTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        blockchainId: STELLAR_BLOCKCHAIN_ID,
        transactionHash: baseRequest.transactionHash,
        refId: baseRequest.refId,
        expectedWalletAddress: baseRequest.expectedSender,
        expectedTokenAddress: baseRequest.expectedTokenAddress,
        expectedAmount: baseRequest.expectedAmount,
        expectedBookingId: baseRequest.expectedBookingId,
        expectedExchangeRateId: baseRequest.expectedExchangeRateId,
        expectedProductVariantId: baseRequest.expectedProductVariantId,
      }),
    );
  });

  it("throws a clear error for a recognized-but-unhandled chain family (Sui/MOVE_VM) instead of misrouting to Solana", async () => {
    const { svc, solana, stellar } = buildService();

    await expect(
      svc.verifyTransaction({
        ...baseRequest,
        blockchainId: SUI_BLOCKCHAIN_ID,
      }),
    ).rejects.toThrow(/Unsupported chain family/);

    expect(solana.verifyTransaction).not.toHaveBeenCalled();
    expect(stellar.verifyTransaction).not.toHaveBeenCalled();
  });

  it("throws a clear error for a genuinely unrecognized chain family value", async () => {
    const { svc, prisma } = buildService();

    (prisma.blockchain.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "blockchain_mystery",
      name: "Mystery Chain",
      isActive: true,
      chainSlug: "mystery-testnet",
      type: "GARBAGE",
    });

    await expect(
      svc.verifyTransaction({
        ...baseRequest,
        blockchainId: "blockchain_mystery",
      }),
    ).rejects.toThrow(/Unrecognized chain family "GARBAGE"/);
  });
});


describe("BlockchainVerificationService.verifyTransaction token check (EVM)", () => {
  const CONTRACT = "0xC0ffee254729296a45a3885639AC7E10F9d54979";
  const BOOKED_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const OTHER_TOKEN = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const request = {
    transactionHash: "0xhash",
    expectedSender: PAYER,
    expectedRecipient: CONTRACT,
    expectedTokenAddress: BOOKED_TOKEN,
    expectedChainId: EVM_CHAIN_ID,
    refId: "ref_001",
    contractAddress: CONTRACT,
    expectedBookingId: "booking_001",
    expectedExchangeRateId: "42",
    expectedProductVariantId: "variant_001",
    expectedAmount: "1000000",
    blockchainId: EVM_BLOCKCHAIN_ID,
  };

  const record = (overrides: Record<string, unknown> = {}) => ({
    walletAddress: PAYER,
    tokenAddress: BOOKED_TOKEN,
    bookingId: "booking_001",
    exchangeRateId: 42n,
    productVariantId: "variant_001",
    timestamp: 1n,
    refId: "ref_001",
    amount: 1000000n,
    ...overrides,
  });

  async function evmService(contractRecord: Record<string, unknown>) {
    const { svc } = buildService();
    // The constructor kicks off an async client refresh; let it settle so it
    // cannot replace the stub client below.
    await new Promise((resolve) => setImmediate(resolve));
    (svc as unknown as { clients: Map<number, unknown> }).clients.set(
      EVM_CHAIN_ID,
      { getBlock: jest.fn(async () => ({ timestamp: 1n })) },
    );
    jest.spyOn(svc, "verifyTxReceiptOnly").mockResolvedValue({
      receipt: {
        transactionHash: "0xhash",
        blockNumber: 1n,
        status: "success",
        gasUsed: 21000n,
      },
      // `to` is the CONTRACT, which is what used to be mistaken for the token.
      transaction: { from: PAYER, to: CONTRACT, value: 0n, chainId: EVM_CHAIN_ID },
      confirmations: 12,
    } as never);
    (readContract as jest.Mock).mockResolvedValue(contractRecord);
    return svc;
  }

  afterEach(() => jest.useRealTimers());

  it("accepts a payment in the booked token", async () => {
    const svc = await evmService(record());
    await expect(svc.verifyTransaction(request)).resolves.toMatchObject({
      isValid: true,
    });
  });

  it("rejects a payment recorded in a different allowed token", async () => {
    const svc = await evmService(record({ tokenAddress: OTHER_TOKEN }));
    await expect(svc.verifyTransaction(request)).rejects.toThrow(
      /token address mismatch/,
    );
  });

  it("rejects a native payment for a booking made in a stablecoin", async () => {
    const svc = await evmService(record({ tokenAddress: NATIVE }));
    await expect(svc.verifyTransaction(request)).rejects.toThrow(
      /token address mismatch/,
    );
  });

  it("rejects a token payment for a booking made in the native currency", async () => {
    const svc = await evmService(record({ tokenAddress: BOOKED_TOKEN }));
    await expect(
      svc.verifyTransaction({ ...request, expectedTokenAddress: NATIVE }),
    ).rejects.toThrow(/token address mismatch/);
  });

  it("accepts a native payment for a native booking", async () => {
    const svc = await evmService(record({ tokenAddress: NATIVE }));
    await expect(
      svc.verifyTransaction({ ...request, expectedTokenAddress: NATIVE }),
    ).resolves.toMatchObject({ isValid: true });
  });

  it("no longer treats the contract address as 'native' (the old bypass)", async () => {
    const svc = await evmService(record({ tokenAddress: OTHER_TOKEN }));
    await expect(
      svc.verifyTransaction({ ...request, expectedTokenAddress: CONTRACT }),
    ).rejects.toThrow(/token address mismatch/);
  });

  it("compares the token case-insensitively", async () => {
    const svc = await evmService(
      record({ tokenAddress: BOOKED_TOKEN.toLowerCase() }),
    );
    await expect(svc.verifyTransaction(request)).resolves.toMatchObject({
      isValid: true,
    });
  });

  it("an absent record is not visible yet, not a chain-verdict mismatch", async () => {
    const svc = await evmService(record({ refId: "" }));
    jest.useFakeTimers();
    const outcome = svc.verifyTransaction(request).catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(10_000);
    const err = (await outcome) as Error;
    expect(err.message).toMatch(/has no record for refId/);
    expect(err.message).not.toMatch(/mismatch/i);
  });
});
