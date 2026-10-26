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

const HOLDER = "0x4444444444444444444444444444444444444444";

let state: {
  totalAssets: bigint;
  depositFeeBps: bigint;
  redeemFeeBps: bigint;
  previewsRevert: boolean;
  /** undefined = the vault has no cooldownDuration() (read reverts) */
  cooldown?: number;
  holders: string[];
  holderBalance: bigint;
  maxRedeem: bigint;
  redeemReverts: boolean;
  logsFail: boolean;
};

jest.mock("./rpc", () => ({
  getPublicClientForChain: () => ({
    getBytecode: async () => "0xdeadbeef",
    getBlockNumber: async () => 1_000_000n,
    getLogs: async () => {
      if (state.logsFail) throw new Error("range too large");
      return state.holders.map((to) => ({ args: { to } }));
    },
    call: async () => {
      if (state.redeemReverts) throw new Error("OperationNotAllowed()");
      return { data: "0x" };
    },
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
        case "balanceOf":
          return state.holderBalance;
        case "maxRedeem":
          return state.maxRedeem;
        case "cooldownDuration":
          if (state.cooldown === undefined) throw new Error("revert");
          return state.cooldown;
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
    cooldown: undefined,
    holders: [HOLDER],
    holderBalance: 10n * UNIT,
    maxRedeem: 10n * UNIT,
    redeemReverts: false,
    logsFail: false,
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

describe("can current holders get out", () => {
  it("admits a vault whose recent holder can redeem", async () => {
    expect(await validateTarget(target, pool())).toBe(true);
  });

  it("refuses when a holder's redeem reverts (Avant, sUSDe)", async () => {
    state.redeemReverts = true;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("refuses when maxRedeem is 0 for a holder with shares", async () => {
    state.maxRedeem = 0n;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("refuses the cooldown convention even with no holder in sight", async () => {
    state.holders = [];
    state.cooldown = 86_400;
    expect(await validateTarget(target, pool())).toBe(false);
  });

  it("admits a cooldown convention vault whose cooldown is off", async () => {
    state.cooldown = 0;
    expect(await validateTarget(target, pool())).toBe(true);
  });

  it("treats no holder, or unreadable logs, as no evidence", async () => {
    state.holders = [];
    expect(await validateTarget(target, pool())).toBe(true);
    state.holders = [HOLDER];
    state.logsFail = true;
    state.redeemReverts = true;
    expect(await validateTarget(target, pool())).toBe(true);
  });

  it("skips holders that no longer hold shares", async () => {
    state.holderBalance = 0n;
    state.redeemReverts = true;
    expect(await validateTarget(target, pool())).toBe(true);
  });
});
