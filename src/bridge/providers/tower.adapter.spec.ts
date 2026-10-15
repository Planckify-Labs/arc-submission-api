import { ConfigService } from "@nestjs/config";
import { DefiError } from "../../strategies/errors/defi-error";
import { getPublicClientForChain } from "../../strategies/targets/rpc";
import { BridgeService } from "../bridge.service";
import { registerBridgeAdapter, resetBridgeAdapters } from "../registry";
import type { BridgeQuoteRequest } from "../types";
import { TowerSwapAdapter } from "./tower.adapter";

jest.mock("../../strategies/targets/rpc", () => ({
  getPublicClientForChain: jest.fn(),
}));

const USER = "0xa54FFd258815Ee711bA0d3Dbb7fA786AEA6095Fb";
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1";
const TESTNET_EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const EXECUTOR = "0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8";
const ARC = "eip155:5042";

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [USDC]: { symbol: "USDC", decimals: 6 },
  [EURC]: { symbol: "EURC", decimals: 6 },
  [TESTNET_EURC]: { symbol: "EURC", decimals: 6 },
};

function rpcClient(overrides: { code?: string } = {}) {
  return {
    readContract: jest.fn(
      ({
        address,
        functionName,
      }: { address: string; functionName: string }) => {
        const meta = TOKENS[address.toLowerCase()];
        if (!meta) return Promise.reject(new Error("no contract"));
        return Promise.resolve(
          functionName === "symbol" ? meta.symbol : meta.decimals,
        );
      },
    ),
    getCode: jest.fn(async () => overrides.code ?? "0x6080604052"),
    getTransactionReceipt: jest.fn(),
  };
}

function towerQuote(over: Record<string, unknown> = {}) {
  return {
    inputToken: USDC,
    outputToken: EURC,
    inputAmountRaw: "1000000",
    outputAmountRaw: "870796",
    minOutRaw: "866442",
    platformFeeAmountRaw: "3000",
    inputTokenDecimals: 6,
    outputTokenDecimals: 6,
    feeBps: 30,
    dexId: "aero",
    dexName: "Aero",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    routeOptions: [{ dexId: "aero" }, { dexId: "uniswap" }],
    ...over,
  };
}

function towerBuild(over: Record<string, unknown> = {}) {
  return {
    approval: { to: USDC, spender: EXECUTOR, amountRaw: "1000000" },
    swap: {
      to: EXECUTOR,
      data: "0xcd6267d5",
      value: "0x0",
      from: USER,
      gasLimit: "0x10c8e0",
      chainId: 5042,
    },
    ...over,
  };
}

type Reply = { status?: number; body: unknown };

function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = jest.fn((url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (!next) return Promise.reject(new Error("unexpected fetch"));
    return Promise.resolve({
      status: next.status ?? 200,
      json: () => Promise.resolve(next.body),
    } as Response);
  }) as unknown as typeof fetch;
  return calls;
}

function adapter(env: Record<string, string> = { TOWER_API_KEY: "sk_test_x" }) {
  return new TowerSwapAdapter({
    get: (k: string) => env[k],
  } as unknown as ConfigService);
}

function request(over: Partial<BridgeQuoteRequest> = {}): BridgeQuoteRequest {
  return {
    fromChain: ARC,
    toChain: ARC,
    fromAsset: `${ARC}/erc20:${USDC}`,
    toAsset: `${ARC}/erc20:${EURC}`,
    amountRaw: "1000000",
    fromAddress: USER,
    toAddress: USER,
    ...over,
  };
}

async function expectDefiCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(DefiError);
  await p.catch((e: DefiError) => expect(e.code).toBe(code));
}

describe("TowerSwapAdapter", () => {
  let client: ReturnType<typeof rpcClient>;

  beforeEach(() => {
    client = rpcClient();
    (getPublicClientForChain as jest.Mock).mockReturnValue(client);
  });

  describe("supports", () => {
    it("serves same-chain Arc mainnet and testnet only", () => {
      const a = adapter();
      expect(a.supports(ARC, ARC)).toBe(true);
      expect(a.supports("eip155:5042002", "eip155:5042002")).toBe(true);
      expect(a.supports(ARC, "eip155:8453")).toBe(false);
      expect(a.supports("eip155:8453", "eip155:8453")).toBe(false);
    });

    it("stays out of the registry's way without an API key", () => {
      expect(adapter({}).supports(ARC, ARC)).toBe(false);
    });
  });

  describe("quote", () => {
    it("pins the network and maps Tower's raw amounts onto the wire quote", async () => {
      const calls = mockFetch([
        { body: { success: true, data: towerQuote() } },
        { body: { success: true, data: towerBuild() } },
      ]);

      const q = await adapter().quote(request());

      expect(calls[0].body).toMatchObject({
        chainId: 5042,
        inputToken: USDC,
        outputToken: EURC,
        inputAmount: "1000000",
        slippageTolerance: 30,
      });
      expect(calls[1].body).toMatchObject({ userAddress: USER, chainId: 5042 });
      expect(q.provider).toBe("tower");
      expect(q.from.amountRaw).toBe("1000000");
      expect(q.to.amountRaw).toBe("870796");
      expect(q.toAmountMinRaw).toBe("866442");
      expect(q.to.token.symbol).toBe("EURC");
      expect(q.fees).toEqual([
        expect.objectContaining({ amountRaw: "3000", included: true }),
      ]);
      expect(q.execution).toEqual({
        kind: "evm_transaction",
        chain: ARC,
        to: EXECUTOR,
        data: "0xcd6267d5",
        value: "0",
        gasLimit: String(0x10c8e0),
        approval: { token: USDC, spender: EXECUTOR, amountRaw: "1000000" },
      });
    });

    it("converts native Arc USDC (18 decimals) onto the 6-decimal ERC-20", async () => {
      const calls = mockFetch([
        { body: { success: true, data: towerQuote() } },
        { body: { success: true, data: towerBuild() } },
      ]);

      const q = await adapter().quote(
        request({
          fromAsset: `${ARC}/slip44:60`,
          amountRaw: "1000000000000123456",
        }),
      );

      expect(calls[0].body.inputAmount).toBe("1000000");
      expect(q.from.token.caip19).toBe(`${ARC}/erc20:${USDC}`);
      expect(q.from.token.decimals).toBe(6);
    });

    it("rejects a quote for a different token than requested", async () => {
      // What Tower does to a testnet address when the network is not pinned.
      mockFetch([
        { body: { success: true, data: towerQuote({ outputToken: EURC }) } },
      ]);
      await expectDefiCode(
        adapter().quote(
          request({
            fromChain: "eip155:5042002",
            toChain: "eip155:5042002",
            fromAsset: `eip155:5042002/erc20:${USDC}`,
            toAsset: `eip155:5042002/erc20:${TESTNET_EURC}`,
          }),
        ),
        "decoded_intent_mismatch",
      );
    });

    it("refuses an executor with no code on-chain", async () => {
      client = rpcClient({ code: "0x" });
      (getPublicClientForChain as jest.Mock).mockReturnValue(client);
      mockFetch([
        { body: { success: true, data: towerQuote() } },
        { body: { success: true, data: towerBuild() } },
      ]);
      await expectDefiCode(adapter().quote(request()), "target_not_a_contract");
    });

    it("refuses a swap target outside the executor allowlist", async () => {
      const rogue = "0x000000000000000000000000000000000000dEaD";
      mockFetch([
        { body: { success: true, data: towerQuote() } },
        {
          body: {
            success: true,
            data: towerBuild({
              approval: null,
              swap: { ...towerBuild().swap, to: rogue },
            }),
          },
        },
      ]);
      await expectDefiCode(
        adapter().quote(request()),
        "target_not_allowlisted",
      );
    });

    it("refuses a transaction that carries native value", async () => {
      mockFetch([
        { body: { success: true, data: towerQuote() } },
        {
          body: {
            success: true,
            data: towerBuild({ swap: { ...towerBuild().swap, value: "0x1" } }),
          },
        },
      ]);
      await expectDefiCode(
        adapter().quote(request()),
        "decoded_intent_mismatch",
      );
    });

    it("falls back to the next venue when a build is refused", async () => {
      const calls = mockFetch([
        {
          body: {
            success: true,
            data: towerQuote({
              dexId: "kyberswap",
              routeOptions: [{ dexId: "kyberswap" }, { dexId: "aero" }],
            }),
          },
        },
        {
          status: 500,
          body: { success: false, error: "Forbidden", code: "BUILD_TX_FAILED" },
        },
        { body: { success: true, data: towerQuote() } },
        { body: { success: true, data: towerBuild() } },
      ]);

      const q = await adapter().quote(request());

      expect(calls[2].body.dexId).toBe("aero");
      // Co-marketing: presented as Tower, never as the DEX underneath.
      expect(q.bridge.name).toBe("Tower");
      expect(q.venue?.name).toBe("Tower");
      expect(q.steps.find((s) => s.kind === "swap")?.provider?.name).toBe("Tower");
    });

    it("reports no route when Tower cannot price the pair", async () => {
      mockFetch([{ body: { success: false, error: "No valid route found" } }]);
      await expectDefiCode(adapter().quote(request()), "unsupported_asset");
    });

    it("treats a rejected key as an outage, not as unsupported", async () => {
      mockFetch([
        { status: 401, body: { success: false, error: "Invalid API key" } },
      ]);
      await expectDefiCode(adapter().quote(request()), "network_error");
    });

    it("does not quote a chain the api has no row for", async () => {
      (getPublicClientForChain as jest.Mock).mockReturnValue(null);
      await expectDefiCode(adapter().quote(request()), "unsupported_chain");
    });

    it("refuses a recipient other than the signer", async () => {
      await expectDefiCode(
        adapter().quote(
          request({ toAddress: "0x000000000000000000000000000000000000bEEF" }),
        ),
        "unsupported_asset",
      );
    });
  });

  describe("status", () => {
    const ref = {
      provider: "tower",
      fromChain: ARC,
      toChain: ARC,
      sourceTxHash: "0xabc",
    };

    it("is settled once the receipt lands", async () => {
      client.getTransactionReceipt.mockResolvedValue({ status: "success" });
      await expect(adapter().status(ref)).resolves.toMatchObject({
        outcome: "completed",
        phase: "settled",
      });
    });

    it("reports a reverted swap as failed", async () => {
      client.getTransactionReceipt.mockResolvedValue({ status: "reverted" });
      await expect(adapter().status(ref)).resolves.toMatchObject({
        outcome: "failed",
      });
    });

    it("is still pending before the receipt exists", async () => {
      client.getTransactionReceipt.mockRejectedValue(
        Object.assign(new Error("not found"), {
          name: "TransactionReceiptNotFoundError",
        }),
      );
      await expect(adapter().status(ref)).resolves.toMatchObject({
        outcome: null,
        phase: "pending_source",
      });
    });
  });
});

describe("BridgeService same-chain routing", () => {
  afterEach(() => resetBridgeAdapters());

  it("keeps same-chain a capability boundary where no adapter swaps", async () => {
    registerBridgeAdapter(adapter());
    const result = await new BridgeService().quote(
      request({
        fromChain: "eip155:8453",
        toChain: "eip155:8453",
        fromAsset: `eip155:8453/erc20:${USDC}`,
        toAsset: `eip155:8453/erc20:${EURC}`,
      }),
    );
    expect(result).toEqual({ routable: false, reason: "same_chain" });
  });

  it("routes a same-chain Arc request to tower", async () => {
    (getPublicClientForChain as jest.Mock).mockReturnValue(rpcClient());
    mockFetch([
      { body: { success: true, data: towerQuote() } },
      { body: { success: true, data: towerBuild() } },
    ]);
    registerBridgeAdapter(adapter());
    const result = await new BridgeService().quote(request());
    expect(result.routable).toBe(true);
  });
});
