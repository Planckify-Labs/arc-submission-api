/**
 * ERC-4626 exit cost and TVL band (validation.ts).
 *
 * Both checks answer a question `asset()` cannot: is this the vault on the
 * card (TVL band), and what does leaving it cost (preview round trip). The
 * numbers in these cases are the ones measured on live vaults on 2026-10-26.
 */

import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { loadChainDirectory } from "./chain-directory";
import type { DepositTarget } from "./types";

const UNDERLYING = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const UNIT = 10n ** 18n;

let state: {
  totalAssets: bigint;
  depositFeeBps: bigint;
  redeemFeeBps: bigint;
  previewsRevert: boolean;
};

jest.mock("./rpc", () => ({
  getPublicClientForChain: () => ({
    getBytecode: async () => "0xdeadbeef",
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly bigint[];
    }) => {
      switch (functionName) {
        case "asset":
          return UNDERLYING;
        case "totalAssets":
          return state.totalAssets;
        case "decimals":
          return 18;
        case "convertToShares":
          return args?.[0] ?? 0n;
        case "maxDeposit":
          return 2n ** 255n;
        case "previewDeposit":
          if (state.previewsRevert) throw new Error("revert");
          return (
            ((args?.[0] ?? 0n) * (10_000n - state.depositFeeBps)) / 10_000n
          );
        case "previewRedeem":
          if (state.previewsRevert) throw new Error("revert");
          return ((args?.[0] ?? 0n) * (10_000n - state.redeemFeeBps)) / 10_000n;
        default:
          throw new Error(`revert:${functionName}`);
      }
    },
  }),
}));

const { validateTarget, setAssetPriceLookup } =
  require("./validation") as typeof import("./validation");

const target: DepositTarget = {
  kind: "erc4626",
  vault: VAULT,
  asset: UNDERLYING,
};

function pool(overrides: Partial<DeFiLlamaYieldPool> = {}): DeFiLlamaYieldPool {
  return {
    pool: "pool-uuid",
    chain: "Ethereum",
    project: "some-vaults",
    symbol: "WETH",
    tvlUsd: 3_000_000,
    apy: 4,
    ilRisk: "no",
    exposure: "single",
    underlyingTokens: [UNDERLYING],
    ...overrides,
  };
}

beforeAll(() => {
  loadChainDirectory([
    {
      chainId: 1,
      name: "Ethereum",
      chainSlug: null,
      rpcUrl: "/rpc",
      family: "EVM",
      isTestnet: false,
    },
  ]);
});

beforeEach(() => {
  process.env.STRATEGIES_TARGET_VALIDATION = "on";
  delete process.env.DEFI_4626_MAX_ROUNDTRIP_LOSS_BPS;
  delete process.env.DEFI_TVL_BAND_FACTOR;
  // 1,000 WETH at $3,000 = the pool's $3M.
  state = {
    totalAssets: 1_000n * UNIT,
    depositFeeBps: 0n,
    redeemFeeBps: 0n,
    previewsRevert: false,
  };
  setAssetPriceLookup(async () => 3_000);
});

afterAll(() => setAssetPriceLookup(null));

describe("exit cost", () => {
  it("admits a vault whose round trip costs a few bps", async () => {
    state.redeemFeeBps = 3n; // Auto Finance measured 3.5 bps
    expect(await validateTarget(target, pool())).toBe(true);
  });

  it("refuses a 0.2% in / 5% out vault (TAU cbETH Dynamic Looping)", async () => {
    state.depositFeeBps = 20n;
    state.redeemFeeBps = 500n;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("refuses a vault whose previews revert: the exit cost is unknowable", async () => {
    state.previewsRevert = true;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("reads the ceiling from ops config", async () => {
    state.redeemFeeBps = 100n;
    expect(await validateTarget(target, pool())).toBe(false);
    process.env.DEFI_4626_MAX_ROUNDTRIP_LOSS_BPS = "150";
    expect(await validateTarget(target, pool())).toBe(true);
  });
});

describe("TVL band binds the vault to the pool on the card", () => {
  it("refuses a non-stable vault three times the pool's size", async () => {
    state.totalAssets = 3_000n * UNIT;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("refuses a vault a third of the pool's size", async () => {
    state.totalAssets = 333n * UNIT;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("skips the band, as before, when there is no price for the asset", async () => {
    setAssetPriceLookup(async () => null);
    state.totalAssets = 3_000n * UNIT;
    expect(await validateTarget(target, pool())).toBe(true);
  });

  it("prices stablecoins at $1 without asking", async () => {
    const lookup = jest.fn(async () => 3_000);
    setAssetPriceLookup(lookup);
    state.totalAssets = 3_000_000n * UNIT;
    expect(await validateTarget(target, pool({ symbol: "USDC" }))).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});
