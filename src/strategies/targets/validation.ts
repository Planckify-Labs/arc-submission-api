/**
 * On-chain validation of a resolved DepositTarget (spec §3.2, §8.1 — MANDATORY).
 *
 * We route user funds, so a resolver's candidate address is verified against
 * the chain before it is trusted. Any failure (mismatch OR unreadable) →
 * `false` → the caller nulls the target → the pool degrades to manual. We
 * never guess.
 *
 * **Every EVM kind must have an explicit validator.** The old
 * `default: return true` passthrough is gone for EVM kinds (§8.1): a new kind
 * that forgets its validator is REJECTED rather than silently trusted, which is
 * the failure mode that would otherwise ship a family with no Layer-1 check.
 * Non-EVM kinds keep resolver-internal validation and pass through.
 *
 * Toggle with `STRATEGIES_TARGET_VALIDATION=off` for local dev without RPC
 * access (validation is trusted-open only when explicitly disabled). Default
 * is ON.
 */

import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseAbiItem,
} from "viem";
import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import {
  findLstVenue,
  isRouterAllowlisted,
  pinnedDestinationFor,
} from "./address-book";
import { isLinkedOnChain } from "./centrifuge.resolver";
import { metaRegistryLpToken } from "./curve.resolver";
import { getPublicClientForChain } from "./rpc";
import type { DepositTarget, MorphoMarketParams } from "./types";
import {
  eqAddr,
  isEvmTargetKind,
  resolveEvmChainId,
  underlyingOf,
} from "./types";

// TVL band (spec §11 Q3): a vault's on-chain TVL must land within
// [tvl / FACTOR, tvl * FACTOR] of DeFiLlama's figure for the pool the user
// picked. It is what binds a candidate to THAT pool: `asset()` proves the
// vault takes the right token, not that it is the vault on the card, and a
// sibling vault of the same asset passes every other check.
//
// Measured 2026-10-26 against the live feed, fresh DeFiLlama TVL and on-chain
// totalAssets agree within 4% (Fluid, Spark, Sky, Yo, Gearbox, Centrifuge on
// Ethereum/Base/Arbitrum/Monad). The only misses were rows whose cached TVL was
// two weeks old. 2x leaves room for price and timing drift; the old 10x let a
// vault five times the size of the pool through.
const DEFAULT_TVL_TOLERANCE_FACTOR = 2;

function tvlToleranceFactor(): number {
  const n = Number(process.env.DEFI_TVL_BAND_FACTOR);
  return Number.isFinite(n) && n > 1 ? n : DEFAULT_TVL_TOLERANCE_FACTOR;
}

// Exit cost (spec §11 Layer 2). ERC-4626 requires `previewDeposit` and
// `previewRedeem` to include the vault's fees, so a deposit-then-redeem preview
// is the round trip a user pays, read off the chain with no funds. Found the
// day this was written: an in-app "TAU cbETH Dynamic Looping" vault charging
// 0.2% in and 5% out (519 bps round trip). Every other in-app 4626 vault
// measured under 4 bps.
const DEFAULT_MAX_ROUNDTRIP_LOSS_BPS = 50;

function maxRoundTripLossBps(): number {
  const n = Number(process.env.DEFI_4626_MAX_ROUNDTRIP_LOSS_BPS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_ROUNDTRIP_LOSS_BPS;
}

/**
 * USD price of an asset, for the TVL band on non-stable vaults. Set by
 * `TargetResolverService` (it owns the budgeted price client); unset, or a
 * null answer, means "no price" and the band is skipped for that vault, as it
 * always was for non-stables.
 */
export type AssetPriceLookup = (
  chainId: number,
  asset: Address,
) => Promise<number | null>;

let assetPriceLookup: AssetPriceLookup | null = null;

export function setAssetPriceLookup(lookup: AssetPriceLookup | null): void {
  assetPriceLookup = lookup;
}

const STABLE_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "PYUSD",
  "USDC.E",
  "GHO",
  "FRAX",
  "LUSD",
  "CRVUSD",
]);

const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function cooldownDuration() view returns (uint24)",
  "function receiveSharesGate() view returns (address)",
  "function sendAssetsGate() view returns (address)",
]);

/**
 * Probe receiver for `maxDeposit`. Any address nobody has allowlisted works —
 * the question being asked is "would an ordinary user be allowed to deposit",
 * and an ordinary user is exactly that. Never used as a call target.
 */
const MAX_DEPOSIT_PROBE =
  "0x000000000000000000000000000000000000dEaD" as Address;

const AAVE_POOL_ABI = parseAbi([
  // Aave v3 Pool.getReserveData returns a struct; we only need aTokenAddress.
  // Using the packed-config tuple shape would be brittle across versions, so
  // we read the aToken via the reserve-data configuration bitmap check
  // indirectly through getReserveData's aTokenAddress field.
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

const COMET_ABI = parseAbi([
  "function baseToken() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

const CTOKEN_ABI = parseAbi([
  "function underlying() view returns (address)",
  "function exchangeRateStored() view returns (uint256)",
]);

const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

const CURVE_ABI = parseAbi([
  "function coins(uint256 i) view returns (address)",
]);

const SOLIDLY_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
]);

const UNISWAP_V2_PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const BALANCER_VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
]);

const ERC165_ABI = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);

/** ERC-7540 asynchronous-vault interface id (spec §8.1). */
const ERC7540_INTERFACE_ID = "0x2f0a18c5";

const ZERO = "0x0000000000000000000000000000000000000000";

function validationEnabled(): boolean {
  return (
    (process.env.STRATEGIES_TARGET_VALIDATION ?? "on").toLowerCase() !== "off"
  );
}

function isStable(symbol: string): boolean {
  const upper = (symbol ?? "").toUpperCase();
  return [...STABLE_SYMBOLS].some((s) => upper.includes(s));
}

type Client = NonNullable<ReturnType<typeof getPublicClientForChain>>;

/**
 * Layer-1 "has code" (§11): a target that is an EOA or undeployed is rejected
 * outright. Cheap, and it catches a whole class of resolver mistakes before any
 * protocol-specific read runs.
 */
async function hasCode(client: Client, address: Address): Promise<boolean> {
  try {
    const code = await client.getBytecode({ address });
    return typeof code === "string" && code.length > 2;
  } catch {
    return false;
  }
}

/**
 * Layer-1 "singleton address-book allowlist" (§11, §12 Q7): for kinds whose
 * destination is a singleton/router, the address MUST be one we pinned. Kinds
 * with legitimately per-vault destinations return `null` from
 * `pinnedDestinationFor` and are admitted by on-chain identity instead.
 */
function passesSingletonAllowlist(
  target: DepositTarget,
  chainId: number,
): boolean {
  const pinned = pinnedDestinationFor(target, chainId);
  if (pinned === null) return true; // not a singleton kind
  if (pinned.length === 0) return false; // singleton kind with no pinned entry
  const destination =
    target.kind === "aave-v3"
      ? target.pool
      : target.kind === "compound-v3"
        ? target.comet
        : target.kind === "solidly-lp"
          ? target.router
          : target.kind === "uniswap-v2"
            ? target.router
            : target.kind === "balancer-lp"
              ? target.vault
              : target.kind === "router-call"
                ? undefined // checked per-quote at build time (§6 guardrail 2)
                : undefined;
  if (target.kind === "router-call") return true;
  if (target.kind === "morpho-blue") return true; // `to` is the pinned singleton
  return pinned.some((a) => eqAddr(a, destination));
}

/** Validate an ERC-4626 vault: asset() matches, 4626 selectors respond, TVL sane. */
async function validateErc4626(
  target: Extract<DepositTarget, { kind: "erc4626" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.vault))) return false;
    const [asset, totalAssets] = await Promise.all([
      client.readContract({
        address: target.vault,
        abi: ERC4626_ABI,
        functionName: "asset",
      }),
      client.readContract({
        address: target.vault,
        abi: ERC4626_ABI,
        functionName: "totalAssets",
      }),
    ]);

    const expected = target.asset ?? underlyingOf(pool);
    if (expected && !eqAddr(asset, expected)) return false;
    if (totalAssets <= 0n) return false;

    // Prove the 4626 selector set responds (not just a plain ERC-20 at the
    // address). convertToShares(1 unit) must not revert.
    const decimals = await client
      .readContract({
        address: asset as Address,
        abi: erc20Abi,
        functionName: "decimals",
      })
      .catch(() => 18);
    const oneUnit = 10n ** BigInt(decimals);
    const shares = await client.readContract({
      address: target.vault,
      abi: ERC4626_ABI,
      functionName: "convertToShares",
      args: [oneUnit],
    });
    // A vault that prices one whole unit at zero shares is either empty in a
    // way that rounds deposits to nothing, or not really 4626.
    if (shares <= 0n) return false;

    // CAN AN ORDINARY USER ACTUALLY DEPOSIT?
    //
    // Everything above proves the vault is real and prices correctly, and none
    // of it proves a deposit would succeed. Maple's syrupUSDC / syrupUSDT are
    // the counter-example: both pass every check above (asset matches, TVL in
    // band, convertToShares fine) and both return `maxDeposit == 0` for anyone
    // not allowlisted, because the pool is permissioned. Without this the pool
    // badges "Deposit in-app" and the user's transaction reverts on chain
    // (verified 2026-08-21).
    //
    // A supply-capped vault also reads 0 here, and refusing that is right too:
    // the deposit really would fail right now.
    //
    // A REVERT is not treated as a zero. ERC-4626 says `maxDeposit` must not
    // revert, but the checks above have already established 4626 behaviour, so
    // a non-conforming-but-working vault should not lose coverage over it.
    const maxDeposit = await client
      .readContract({
        address: target.vault,
        abi: ERC4626_ABI,
        functionName: "maxDeposit",
        args: [MAX_DEPOSIT_PROBE],
      })
      .catch(() => null);
    if (
      maxDeposit !== null &&
      maxDeposit === 0n &&
      !(await depositGatesOpen(client, target.vault))
    )
      return false;

    if (!(await exitCostAcceptable(client, target.vault, oneUnit)))
      return false;
    if (await inCooldownConvention(client, target.vault)) return false;
    if ((await holdersCanExit(client, target.vault, shares)) === false)
      return false;

    // TVL band. Stablecoins price at ~$1; anything else needs a price, and
    // without one the band is skipped (it always was for non-stables).
    if (pool.tvlUsd > 0) {
      const price = isStable(pool.symbol)
        ? 1
        : await assetPriceLookup?.(chainId, asset as Address).catch(() => null);
      if (typeof price === "number" && price > 0) {
        const onchainUsd = (Number(totalAssets) / Number(oneUnit)) * price;
        const factor = tvlToleranceFactor();
        if (
          onchainUsd < pool.tvlUsd / factor ||
          onchainUsd > pool.tvlUsd * factor
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What a deposit-then-redeem of `amount` returns, per the vault's own previews.
 * A preview that reverts is a refusal: the exit cost is then unknowable, and
 * "we could not tell what leaving costs" is not a vault to put money into.
 */
async function exitCostAcceptable(
  client: Client,
  vault: Address,
  amount: bigint,
): Promise<boolean> {
  try {
    const shares = await client.readContract({
      address: vault,
      abi: ERC4626_ABI,
      functionName: "previewDeposit",
      args: [amount],
    });
    const back = await client.readContract({
      address: vault,
      abi: ERC4626_ABI,
      functionName: "previewRedeem",
      args: [shares],
    });
    if (back >= amount) return true;
    const lossBps = Number(((amount - back) * 10_000n) / amount);
    return lossBps <= maxRoundTripLossBps();
  } catch {
    return false;
  }
}

/**
 * Morpho Vault V2 convention: `maxDeposit` (and every other max* view) returns
 * 0 by design, because who may deposit is decided by gate contracts instead.
 * A deposit is open to anyone exactly when the two gates on the deposit path,
 * `receiveSharesGate` and `sendAssetsGate`, are unset. A set gate is a
 * contract we cannot reason about, so it stays a refusal, the same as any
 * other `maxDeposit == 0` (Maple's permissioned syrup pools).
 *
 * Measured 2026-10-26 on Arc: every Morpho-listed V2 vault (Galaxy, Keyrock,
 * Steakhouse, Gauntlet, Bitwise) has both gates unset.
 */
async function depositGatesOpen(
  client: Client,
  vault: Address,
): Promise<boolean> {
  const [shares, assets] = await Promise.all(
    (["receiveSharesGate", "sendAssetsGate"] as const).map((functionName) =>
      client
        .readContract({ address: vault, abi: ERC4626_ABI, functionName })
        .catch(() => null),
    ),
  );
  return (
    typeof shares === "string" &&
    typeof assets === "string" &&
    eqAddr(shares, ZERO) &&
    eqAddr(assets, ZERO)
  );
}

/**
 * Ethena's `StakedUSDeV2` convention (sUSDe, Avant's savUSD/savETH): while
 * `cooldownDuration()` is non-zero, `withdraw`/`redeem` revert outright and
 * the only exit is `cooldownShares()` -> wait -> `unstake()`, which the
 * generic 4626 adapter does not do. A vault that reads non-zero here takes the
 * deposit and then cannot be left through the app (Avant, runbook §11.6a), so
 * it is refused. Vaults without the function revert on the read: not this
 * convention.
 */
async function inCooldownConvention(
  client: Client,
  vault: Address,
): Promise<boolean> {
  const cooldown = await client
    .readContract({
      address: vault,
      abi: ERC4626_ABI,
      functionName: "cooldownDuration",
    })
    .catch(() => null);
  return typeof cooldown === "number" ? cooldown > 0 : false;
}

// How far back to look for a current holder: newest slice first, stopping once
// enough holders are found, so a busy vault costs one slice and a quiet one at
// most `MAX_CHUNKS`. Providers cap an `eth_getLogs` range (Alchemy's free tier
// at 10 blocks), so the slice size is ops config.
function holderScanMaxChunks(): number {
  const n = Number(process.env.DEFI_4626_HOLDER_SCAN_MAX_CHUNKS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function holderScanChunk(): bigint {
  const n = Number(process.env.DEFI_4626_HOLDER_SCAN_CHUNK);
  return BigInt(Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000);
}

const MAX_HOLDERS_TRIED = 5;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * Can the people already in this vault get out right now?
 *
 * Previews say what leaving costs; they cannot say leaving is allowed. Avant
 * was the case that taught this: a conforming ERC-4626 vault that took
 * deposits and then reverted `redeem()` under a cooldown, so a user would have
 * been in with no way out. It was caught by a fork test, which only runs for
 * vaults someone thought to fork.
 *
 * This asks the live chain instead, with no funds: find a recent recipient of
 * the vault's shares who still holds some, then
 *   1. `maxRedeem(holder)` must not be 0 while they hold shares, and
 *   2. a small `redeem` simulated AS that holder (`eth_call`, nothing signed)
 *      must not revert.
 * `false` refuses the vault. `null` means no holder was found (or the logs
 * could not be read): no evidence either way, and the other checks stand.
 */
async function holdersCanExit(
  client: Client,
  vault: Address,
  probeShares: bigint,
): Promise<boolean | null> {
  let holders: Address[];
  try {
    holders = await recentShareRecipients(client, vault);
  } catch {
    return null;
  }
  for (const holder of holders) {
    const balance = await client
      .readContract({
        address: vault,
        abi: ERC4626_ABI,
        functionName: "balanceOf",
        args: [holder],
      })
      .catch(() => 0n);
    if (balance <= 0n) continue;

    // No `maxRedeem` gate here: Morpho Vault V2 returns 0 from every max*
    // view by design, and the simulated redeem below is the ground truth a
    // `maxRedeem` of 0 was only ever a proxy for.
    const shares = balance < probeShares ? balance : probeShares;
    try {
      await client.call({
        account: holder,
        to: vault,
        data: encodeFunctionData({
          abi: ERC4626_ABI,
          functionName: "redeem",
          args: [shares, holder, holder],
        }),
      });
      return true;
    } catch {
      return false;
    }
  }
  return null;
}

/** Distinct `to` addresses of the vault's recent share transfers, newest first. */
async function recentShareRecipients(
  client: Client,
  vault: Address,
): Promise<Address[]> {
  const head = await client.getBlockNumber();
  const chunk = holderScanChunk();
  const span = chunk * BigInt(holderScanMaxChunks());
  const floor = head > span ? head - span : 0n;
  const seen = new Set<string>();
  const out: Address[] = [];
  for (
    let to = head;
    to > floor && out.length < MAX_HOLDERS_TRIED;
    to -= chunk
  ) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    const logs = await client.getLogs({
      address: vault,
      event: TRANSFER_EVENT,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of [...logs].reverse()) {
      const recipient = log.args.to;
      if (!recipient || eqAddr(recipient, ZERO) || eqAddr(recipient, vault))
        continue;
      const key = recipient.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(recipient as Address);
      if (out.length >= MAX_HOLDERS_TRIED) break;
    }
  }
  return out;
}

/** Validate an Aave v3 reserve: the asset is a listed reserve with an aToken. */
async function validateAaveV3(
  target: Extract<DepositTarget, { kind: "aave-v3" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.pool))) return false;
    const data = await client.readContract({
      address: target.pool,
      abi: AAVE_POOL_ABI,
      functionName: "getReserveData",
      args: [target.asset],
    });
    // aTokenAddress non-zero ⇒ the reserve is listed on this Pool.
    return !eqAddr(data.aTokenAddress, ZERO) && data.aTokenAddress !== ZERO;
  } catch {
    return false;
  }
}

/**
 * Comet: `baseToken()` must be the asset we intend to supply, and the market
 * must be non-empty. Supplying a non-base asset to Comet is a COLLATERAL
 * deposit, which is out of scope (supply-side only) and behaves differently —
 * so proving the base asset is what makes this target safe.
 */
async function validateCompoundV3(
  target: Extract<DepositTarget, { kind: "compound-v3" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.comet))) return false;
    const [baseToken, totalSupply] = await Promise.all([
      client.readContract({
        address: target.comet,
        abi: COMET_ABI,
        functionName: "baseToken",
      }),
      client.readContract({
        address: target.comet,
        abi: COMET_ABI,
        functionName: "totalSupply",
      }),
    ]);
    if (!eqAddr(baseToken, target.asset)) return false;
    return totalSupply > 0n;
  } catch {
    return false;
  }
}

/**
 * Compound-v2 cToken: `underlying()` must equal the asset and the exchange
 * rate must be non-zero (a zero rate makes the share maths meaningless).
 *
 * Native-asset markets (cETH and its fork equivalents) have NO `underlying()`
 * at all — the call reverts. Those are deliberately rejected rather than
 * special-cased: the deposit shape differs (payable `mint()` with no argument),
 * so admitting them here would build a call that cannot succeed.
 */
async function validateCompoundV2(
  target: Extract<DepositTarget, { kind: "compound-v2" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.cToken))) return false;
    const underlying = await client.readContract({
      address: target.cToken,
      abi: CTOKEN_ABI,
      functionName: "underlying",
    });
    if (!eqAddr(underlying, target.asset)) return false;
    const rate = await client.readContract({
      address: target.cToken,
      abi: CTOKEN_ABI,
      functionName: "exchangeRateStored",
    });
    return rate > 0n;
  } catch {
    return false;
  }
}

/**
 * Re-derive `keccak256(abi.encode(params))` and require it to equal the
 * `marketId` the API claimed. This is the check that closes the "wrong struct"
 * hole (§3.1, §5.2): the id is what identifies the market on-chain, and the
 * struct is what we will actually pass to `supply` — if they disagree, the API
 * is wrong or lying and the target is worthless either way.
 */
export function deriveMorphoMarketId(params: MorphoMarketParams): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        params.loanToken,
        params.collateralToken,
        params.oracle,
        params.irm,
        BigInt(params.lltv),
      ],
    ),
  );
}

async function validateMorphoBlue(
  target: Extract<DepositTarget, { kind: "morpho-blue" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    // 1. The struct must hash to the id. No chain call needed, and it is the
    //    cheapest and most important of the three checks.
    let derived: string;
    try {
      derived = deriveMorphoMarketId(target.params);
    } catch {
      return false; // non-numeric lltv, malformed address
    }
    if (!eqAddr(derived, target.marketId)) return false;

    // 2. The deposited asset is the market's loan token.
    const underlying = underlyingOf(pool);
    if (!eqAddr(target.params.loanToken, target.asset)) return false;
    if (underlying && !eqAddr(target.params.loanToken, underlying))
      return false;

    // 3. The market exists and has a supply side.
    const singleton = pinnedDestinationFor(target, chainId);
    const morpho = singleton?.[0];
    if (!morpho) return false;
    if (!(await hasCode(client, morpho))) return false;
    const market = await client.readContract({
      address: morpho,
      abi: MORPHO_ABI,
      functionName: "market",
      args: [target.marketId],
    });
    return market[0] > 0n;
  } catch {
    return false;
  }
}

/**
 * Curve: the pool's `coins[index]` must be exactly the asset we intend to
 * deposit, and the coin count must match what the target claims. A wrong index
 * silently deposits into a different leg of the pool, so this is the check that
 * matters most for the family.
 */
async function validateCurveLp(
  target: Extract<DepositTarget, { kind: "curve-lp" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  if (target.index < 0 || target.index >= target.nCoins) return false;
  try {
    if (!(await hasCode(client, target.pool))) return false;
    const coin = await client.readContract({
      address: target.pool,
      abi: CURVE_ABI,
      functionName: "coins",
      args: [BigInt(target.index)],
    });
    if (!eqAddr(coin, target.asset)) return false;

    // The claimed arity must be real: coins(nCoins - 1) resolves and
    // coins(nCoins) does not.
    const last = await client
      .readContract({
        address: target.pool,
        abi: CURVE_ABI,
        functionName: "coins",
        args: [BigInt(target.nCoins - 1)],
      })
      .catch(() => null);
    if (!last) return false;
    const beyond = await client
      .readContract({
        address: target.pool,
        abi: CURVE_ABI,
        functionName: "coins",
        args: [BigInt(target.nCoins)],
      })
      .catch(() => null);
    if (beyond !== null) return false;

    // Classic pools carry a `lpToken` distinct from `pool` (§11.6c). This is
    // an independent RE-DERIVATION, not a trust of the resolver's own answer:
    // the validator asks the same first-party MetaRegistry the resolver asked
    // and requires an EXACT match, so a resolver bug or a stale cached target
    // cannot smuggle a wrong receipt address past Layer-1. `undefined` on both
    // sides (the common NG case) also passes, since there is nothing to
    // re-derive.
    if (target.lpToken) {
      const canonical = await metaRegistryLpToken(client, chainId, target.pool);
      if (!canonical || !eqAddr(canonical, target.lpToken)) return false;
      if (!(await hasCode(client, target.lpToken))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Solidly: the pool's own token pair and invariant must match the target. */
async function validateSolidlyLp(
  target: Extract<DepositTarget, { kind: "solidly-lp" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.pool))) return false;
    if (!(await hasCode(client, target.router))) return false;
    const [token0, token1, stable] = await Promise.all([
      client.readContract({
        address: target.pool,
        abi: SOLIDLY_POOL_ABI,
        functionName: "token0",
      }),
      client.readContract({
        address: target.pool,
        abi: SOLIDLY_POOL_ABI,
        functionName: "token1",
      }),
      client.readContract({
        address: target.pool,
        abi: SOLIDLY_POOL_ABI,
        functionName: "stable",
      }),
    ]);
    return (
      eqAddr(token0, target.token0) &&
      eqAddr(token1, target.token1) &&
      Boolean(stable) === target.stable
    );
  } catch {
    return false;
  }
}

/**
 * Uniswap v2: the pair must actually report these two legs. No `stable` check
 * — unlike Solidly, a v2 pair has no invariant choice to confirm.
 */
async function validateUniswapV2(
  target: Extract<DepositTarget, { kind: "uniswap-v2" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.pool))) return false;
    if (!(await hasCode(client, target.router))) return false;
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: target.pool,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token0",
      }),
      client.readContract({
        address: target.pool,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token1",
      }),
    ]);
    return eqAddr(token0, target.token0) && eqAddr(token1, target.token1);
  } catch {
    return false;
  }
}

/** Balancer: the Vault must know this poolId, and the pool must hold the asset. */
async function validateBalancerLp(
  target: Extract<DepositTarget, { kind: "balancer-lp" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.vault))) return false;
    const result = await client.readContract({
      address: target.vault,
      abi: BALANCER_VAULT_ABI,
      functionName: "getPoolTokens",
      args: [target.poolId],
    });
    const tokens = result[0] as readonly string[];
    if (!tokens || tokens.length === 0) return false;
    return tokens.some((t) => eqAddr(t, target.asset));
  } catch {
    return false;
  }
}

/**
 * LST: the venue must be one we pinned, on the chain we pinned it for, and the
 * receipt token must actually be deployed. The stake shape itself is config
 * (address-book), so proving the venue is the identity check that matters.
 */
async function validateLstStake(
  target: Extract<DepositTarget, { kind: "lst-stake" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  const venue = findLstVenue(target.venue);
  if (!venue) return false;
  if (venue.chainId !== chainId) return false;
  if (!eqAddr(venue.receipt, target.receipt)) return false;
  if (!eqAddr(venue.asset, target.asset)) return false;
  if (venue.exit !== target.exit) return false;
  try {
    return (
      (await hasCode(client, venue.entry)) &&
      (await hasCode(client, venue.receipt))
    );
  } catch {
    return false;
  }
}

/**
 * router-call: there is nothing on-chain to verify at RESOLVE time — the
 * calldata does not exist yet. What we can prove is that a pinned router exists
 * for this (protocol, chain) and that the market is a deployed contract. The
 * real gate for this family is at build time: the returned `to` must be on the
 * allowlist, the quote's slippage capped, the call simulated, and the decoded
 * intent asserted (§6 guardrails 1-4).
 */
async function validateRouterCall(
  target: Extract<DepositTarget, { kind: "router-call" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  if (chainId !== target.chainId) return false;
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  const pinned = pinnedDestinationFor(target, chainId);
  if (!pinned || pinned.length === 0) return false;
  try {
    return await hasCode(client, target.market);
  } catch {
    return false;
  }
}

/**
 * ERC-7540 async vault. NO resolver emits this kind yet (§7 — the two-phase
 * request/claim interface has to ship first), so in practice this validator
 * guards against a future resolver landing ahead of the adapter. It proves the
 * vault really is 7540 rather than a sync 4626 that would silently strand a
 * deposit in a request state nothing ever claims.
 */
async function validateAsyncVault(
  target: Extract<DepositTarget, { kind: "async-vault" }>,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  const chainId = resolveEvmChainId(pool.chain);
  const client = getPublicClientForChain(chainId);
  if (!client) return false;
  try {
    if (!(await hasCode(client, target.vault))) return false;
    const supports = await client.readContract({
      address: target.vault,
      abi: ERC165_ABI,
      functionName: "supportsInterface",
      args: [ERC7540_INTERFACE_ID as `0x${string}`],
    });
    if (!supports) return false;
    const asset = await client.readContract({
      address: target.vault,
      abi: ERC4626_ABI,
      functionName: "asset",
    });
    if (!eqAddr(asset, target.asset)) return false;

    // Centrifuge-specific, and harmless for any future ERC-7540 protocol
    // that has no such registry: `isLinkedOnChain` is scoped to the ONE
    // pinned `CENTRIFUGE_VAULT_REGISTRY` address, so a vault from a
    // different protocol simply gets a `false` read (registry does not
    // recognise it) rather than a wrong answer. Independent re-derivation
    // of what the resolver already checked, not a trust of its claim — the
    // same pattern Curve's `lpToken` re-check follows: their own indexer
    // (verified 2026-08-22) lists superseded vault contracts alongside the
    // live one with nothing in the API response distinguishing them, and
    // `supportsInterface`/`asset()` both pass on a superseded vault too, so
    // without this a stale vault would validate cleanly.
    return await isLinkedOnChain(client, target.vault);
  } catch {
    return false;
  }
}

/**
 * Non-EVM kinds whose resolver does its own identity work, each with WHERE
 * that happens. This is a declaration, not a courtesy list: the `default`
 * branch below rejects anything absent from it, so a new Sui/Solana kind is
 * refused until someone states what validates it — the same ratchet §8.1
 * installed for EVM, which until now stopped at the EVM boundary.
 *
 * "Resolver-internal" is a weaker claim than an EVM Layer-1 validator and is
 * recorded as such: none of these resolvers reads the chain (measured
 * 2026-08-27 — zero `getObject`/`getAccountInfo` calls across all of them).
 * What they do is join a protocol's own API on an identity the DeFiLlama row
 * already carries (mint pair, market name, coinType) and refuse an ambiguous
 * match. The on-chain half of the check lives on the DEVICE, where the
 * `ChainSafetyProvider` verifies the account's owning program (Solana) or the
 * object's type origin (Sui) before anything is signed. Two anchors, §11.1 —
 * but both halves of the Solana/Sui pair are thinner than the EVM equivalent,
 * and the runbook's §12.3 sign-off is what covers the difference.
 */
const RESOLVER_VALIDATED_KINDS: Readonly<Record<string, string>> = {
  // ── Sui ───────────────────────────────────────────────────────────────
  "scallop-market":
    "scallop.resolver.ts — coinType matched against the venue's own market list",
  "navi-pool": "navi.resolver.ts — coinType matched against NAVI's pools API",
  "ember-vault":
    "ember.resolver.ts — poolMeta ↔ vault name, refuses ambiguity",
  "kai-vault": "kai.resolver.ts — vault matched on its own API by coinType",
  "suilend-market":
    "suilend.resolver.ts — pinned lending market + reserve index",
  "current-market": "current.resolver.ts — market matched on the app's own API",
  "sui-lst":
    "suilst.resolver.ts — pinned venue table (sui-lst.config.ts), inAppDeposit gated",
  "cetus-clmm-pool":
    "cetus.resolver.ts — pool recovered from Cetus's API by mint pair + tick spacing",
  "turbos-clmm-pool":
    "turbos.resolver.ts — pool recovered from Turbos's /pools stats API",
  "bluefin-spot-pool":
    "bluefin.resolver.ts — pool recovered from Bluefin's /pools/info API",
  // ── Solana ────────────────────────────────────────────────────────────
  "solana-reserve":
    "kamino-lend.resolver.ts — reserve joined on market name + mint, 10x TVL disambiguation",
  "solana-lst-stake":
    "solana-lst.resolver.ts — pinned venue table (solana-lst.config.ts)",
  "jupiter-lend-vault":
    "jupiter-lend.resolver.ts — Earn-only poolMeta gate, asset from the row",
  "kamino-kvault":
    "kamino-kvault.resolver.ts — pinned venue table, poolMeta matched",
  "kamino-liquidity-strategy":
    "kamino-liquidity.resolver.ts — strategy joined on mint pair, TVL disambiguation",
  "raydium-cpmm-pool":
    "raydium-cpmm.resolver.ts — programId-filtered, 10x TVL disambiguation",
  "raydium-amm-v4-pool":
    "raydium-amm-v4.resolver.ts — programId-filtered, same discipline",
  "raydium-stable-pool":
    "raydium-stable.resolver.ts — programId-filtered, same discipline",
  "jito-vault-deposit": "jito-vault.resolver.ts — pinned vault table",
};

/** Exported so `validation.spec.ts` can assert the union stays covered. */
export function isResolverValidatedKind(kind: string): boolean {
  return Object.hasOwn(RESOLVER_VALIDATED_KINDS, kind);
}

/**
 * Validate a resolved target on-chain.
 *
 * EVM kinds are exhaustive by construction: `isEvmTargetKind` drives a
 * `false` default so a new EVM kind without a validator here is REJECTED, per
 * §8.1. Non-EVM kinds must name their resolver-internal validation in
 * `RESOLVER_VALIDATED_KINDS`; an unlisted kind is refused rather than trusted.
 */
export async function validateTarget(
  target: DepositTarget,
  pool: DeFiLlamaYieldPool,
): Promise<boolean> {
  if (!validationEnabled()) return true;

  // Layer-1 singleton allowlist runs before any protocol read: an address we
  // never pinned is rejected without spending an RPC call on it.
  if (isEvmTargetKind(target.kind)) {
    const chainId = resolveEvmChainId(pool.chain);
    if (!chainId) return false;
    if (!passesSingletonAllowlist(target, chainId)) return false;
  }

  switch (target.kind) {
    case "erc4626":
      return await validateErc4626(target, pool);
    case "aave-v3":
      return await validateAaveV3(target, pool);
    case "compound-v3":
      return await validateCompoundV3(target, pool);
    case "compound-v2":
      return await validateCompoundV2(target, pool);
    case "morpho-blue":
      return await validateMorphoBlue(target, pool);
    case "curve-lp":
      return await validateCurveLp(target, pool);
    case "solidly-lp":
      return await validateSolidlyLp(target, pool);
    case "uniswap-v2":
      return await validateUniswapV2(target, pool);
    case "balancer-lp":
      return await validateBalancerLp(target, pool);
    case "lst-stake":
      return await validateLstStake(target, pool);
    case "router-call":
      return await validateRouterCall(target, pool);
    case "async-vault":
      return await validateAsyncVault(target, pool);
    default:
      // Non-EVM / bespoke families validate within their resolver (§3.2) —
      // but only the ones that have SAID SO. An EVM kind never reaches here
      // (`isEvmTargetKind` above proves the switch is exhaustive for them), so
      // this is the non-EVM ratchet: unlisted ⇒ refused ⇒ the pool degrades to
      // Manual, which is the same fail-closed direction every other layer
      // takes.
      return (
        !isEvmTargetKind(target.kind) && isResolverValidatedKind(target.kind)
      );
  }
}

/** Re-exported for the router-call build-time guardrail (§6 guardrail 2). */
export { isRouterAllowlisted };
