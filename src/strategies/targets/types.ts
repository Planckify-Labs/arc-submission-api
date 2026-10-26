/**
 * Pool-level deposit resolution — shared types (docs/defi-pool-level-deposits-spec.md §4.1, §5).
 *
 * A DeFiLlama `pool` id is an opaque UUID, NOT an on-chain address.
 * `DepositTarget` is the resolved, on-chain-validated deposit destination a
 * `PoolTargetResolver` turns that UUID into (via the pool's matching keys:
 * project + chain + underlyingTokens + poolMeta). It is a discriminated union
 * keyed by `kind`; the mobile adapter registry routes one target to exactly
 * one adapter by that `kind` (spec §7). `null` = unresolved → the pool degrades
 * to the manual deep-link path (fail-closed, §2.1).
 *
 * This is the BACKEND twin of the mobile `DepositTarget` in
 * `mobile-app/services/defi/types.ts` — keep the two in sync.
 */

import type { DeFiLlamaYieldPool } from "../external/defillama.client";

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * Morpho Blue market identity (EVM-protocol-expansion spec §3.1).
 *
 * `supply`/`withdraw` on the Morpho singleton take the FULL struct — the
 * market id is `keccak256(abi.encode(params))`, a one-way hash you cannot
 * invert on-chain, so a target carrying only `marketId` cannot build a
 * transaction. The resolver fills this from Morpho's own API and the
 * validator re-derives the hash before the target is trusted (§5.2).
 *
 * `lltv` is a uint256 **decimal string**, not a bigint: `DepositTarget` is a
 * WIRE type (persisted in `OpportunityCache.depositTarget` as JSON, shipped to
 * mobile over HTTP) and `JSON.stringify` throws on BigInt. Adapters parse it
 * with `BigInt(...)` at build time.
 */
export interface MorphoMarketParams {
  /** The asset a lender supplies (== the pool's underlying). */
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  /** uint256, 1e18-scaled, as a decimal string (JSON-safe). */
  lltv: string;
}

/**
 * Sentinel for "the chain's native coin" in an EVM `asset` field (spec §12 Q5).
 * Native deposits set `value: amount` on the built call and omit
 * `needsApproval` — there is no ERC-20 `approve` for ETH, and emitting one
 * would be a no-op that masks a mis-build.
 */
export const NATIVE_ASSET_SENTINEL =
  "0x0000000000000000000000000000000000000000" as Address;

export type DepositTarget =
  | { kind: "erc4626"; vault: Address; asset: Address }
  | { kind: "aave-v3"; pool: Address; asset: Address }
  // Morpho Blue isolated market on the singleton `Morpho` contract. `marketId`
  // is identity/validation only; `params` is what `supply`/`withdraw` actually
  // take, and `asset` (== params.loanToken) is the deposited token (§3.1).
  | {
      kind: "morpho-blue";
      marketId: Hex;
      params: MorphoMarketParams;
      asset: Address;
    }
  | { kind: "compound-v3"; comet: Address; asset: Address }
  // Compound-v2 cToken forks (Venus vToken, Benqi qiToken, Sonne…). `mint`/
  // `redeem`/`redeemUnderlying` with exchange-rate shares (§5.4). Prefer a
  // protocol's ERC-4626 wrapper (Family A) when one exists — §12 Q3.
  | { kind: "compound-v2"; cToken: Address; asset: Address }
  // Curve LP. `index` is the coin's slot in the pool's `coins[]`; `nCoins` +
  // `isNg` are carried so the adapter picks the right `add_liquidity` arity
  // and index type without an on-chain probe per build (§3.3).
  | {
      kind: "curve-lp";
      pool: Address;
      asset: Address;
      index: number;
      nCoins: 2 | 3 | 4;
      isNg: boolean;
      /**
       * The LP receipt token, when it is NOT the pool contract itself.
       *
       * Curve's NG generation (and every pool this family shipped with before
       * 2026-08-21) mints its LP token AS the pool contract, so `lpToken` is
       * absent and every reader falls back to `pool`. Classic pools (3pool and
       * its lineage) mint a SEPARATE ERC-20 — `pool` has no `balanceOf` at
       * all — so THIS is where a withdraw or a position read must look
       * instead. Read from Curve's own MetaRegistry (`get_lp_token`), never
       * guessed: a wrong value here reads a balance from the wrong contract
       * and a `MAX` withdraw silently burns zero.
       */
      lpToken?: Address;
    }
  // Solidly-fork LP (Aerodrome on Base, Velodrome on OP). Deposits go through
  // the Router's `addLiquidity`; `stable` picks the invariant (§6.1).
  | {
      kind: "solidly-lp";
      router: Address;
      pool: Address;
      token0: Address;
      token1: Address;
      stable: boolean;
    }
  // Uniswap v2 pairs (§6.1-adjacent). No `stable` field — every v2 pool is
  // constant-product, unlike its Solidly descendants.
  | {
      kind: "uniswap-v2";
      router: Address;
      pool: Address;
      token0: Address;
      token1: Address;
    }
  // Balancer v3 / Beets. `poolId` is the Vault registration id; `asset` is the
  // single token joined with (§6.2).
  | { kind: "balancer-lp"; vault: Address; poolId: Hex; asset: Address }
  // Liquid staking / restaking (§6.4). `venue` selects the pinned entry
  // contract + stake shape from the address-book; `receipt` is the
  // rate-appreciating token; `exit` records how a withdraw is serviced so the
  // UI never promises an instant exit it can't honour (§12 Q2).
  // `asset` is `NATIVE_ASSET_SENTINEL` for native-ETH stakes.
  | {
      kind: "lst-stake";
      venue: string;
      receipt: Address;
      asset: Address;
      exit: "queue" | "dex" | "instant";
    }
  // Router-calldata families (Pendle, Uniswap LP) — no stable on-chain deposit
  // ABI we encode; the protocol's hosted API returns the calldata at execute
  // time. The target models IDENTITY only (§3.4, §6).
  | {
      kind: "router-call";
      protocol: "pendle" | "uniswap-v3" | "uniswap-v4";
      market: Address;
      chainId: number;
      tokenIn: Address;
    }
  // ERC-7540 asynchronous vault (request → fulfil → claim). Tier 4: the kind
  // exists so the union is complete and the validator can reject a
  // non-conforming vault, but NO resolver emits it until the two-phase
  // adapter interface ships (§7) — async pools stay Manual until then.
  | {
      kind: "async-vault";
      vault: Address;
      asset: Address;
      flavor: "7540-deposit" | "7540-redeem" | "7540-both";
    }
  | { kind: "scallop-market"; market: string; coinType: string }
  // Ember Vaults (Sui) — `ember_vaults::gateway::deposit_asset_v2<T,R>`.
  // `vault` = immutable shared Vault<T,R> object id; `coinType` = deposited coin
  // (T, == underlyingTokens[0]); `shareType` = receipt coin (R). Package +
  // ProtocolConfig are mutable → fetched by the mobile adapter, not in the
  // target. Resolved from the Bluefin Ember Vaults API (§3.1: prefer the plain
  // HTTPS endpoint over the SDK).
  | { kind: "ember-vault"; vault: string; coinType: string; shareType: string }
  // NAVI (Sui lending) — `lending_core::incentive_v3::entry_deposit<T>`. No
  // receipt coin: supply is tracked in NAVI's shared `Storage` keyed by numeric
  // `assetId` (+ per-coin `Pool<T>` object). `coinType` == underlyingTokens[0].
  | { kind: "navi-pool"; pool: string; assetId: number; coinType: string }
  // Suilend (Sui lending) — `lending_market::deposit_liquidity_and_mint_ctokens
  // <P,T>`. `lendingMarket` = shared LendingMarket<P> object; `marketType` = the
  // P phantom (`<pkg>::suilend::MAIN_POOL`) — the mobile adapter fetches the
  // CURRENT moveCall package from an on-chain UpgradeCap read, not derived
  // from this immutable type prefix (corrected 2026-08-22 — deposit is
  // oracle-free and device-verified, matching every other kind here; the
  // prior "Pyth-gated" claim for BOTH deposit and withdraw was a stale-
  // package false alarm, see `suilendSui.ts`'s header in mobile);
  // `reserveArrayIndex` = the reserve's slot in LendingMarket.reserves[] (u64
  // arg); `coinType` (T) == underlyingTokens[0]. Receipt =
  // `Coin<reserve::CToken<P,T>>`.
  | {
      kind: "suilend-market";
      lendingMarket: string;
      marketType: string;
      reserveArrayIndex: number;
      coinType: string;
    }
  // Sui liquid staking (Haedal / Volo / SpringSui / Aftermath). The user
  // supplies `Coin<SUI>` and receives a liquid-staking receipt coin; the
  // deposit is ORACLE-FREE (no Pyth) — like Suilend's, not unlike it (see
  // above). `venue` selects the mobile adapter's pinned stake shape + shared
  // objects; `lstType` is the receipt coin. These pools are NOT in
  // DeFiLlama — the `SuiLstSource` synthesizes them.
  | { kind: "sui-lst"; venue: string; lstType: string }
  // Kai Finance Single Asset Vaults (Sui) — `vault::deposit<T,Y>(&mut
  // Vault<T,Y>, Balance<T>, &Clock) -> Balance<Y>`, and withdraw is two calls:
  // `vault::withdraw<T,Y>(&mut Vault<T,Y>, Balance<Y>, &Clock) -> WithdrawTicket<T,Y>`
  // then `vault::redeem_withdraw_ticket<T,Y>(&mut Vault<T,Y>, WithdrawTicket<T,Y>)
  // -> Balance<T>` — both devInspect-verified to chain atomically in one PTB
  // even against a vault with zero idle `free_balance` (2026-08-22). No oracle
  // either direction. `vault` + `coinType` (T) are pinned (no public API; Kai
  // has no on-chain registry to enumerate either — mirrored from the
  // open-source `DefiLlama/yield-server` kai-finance adaptor's fixed vault
  // list); `shareType` (Y) is read live off the vault object's own type
  // (never pinned) since it's cheap and removes one more hand-copied string.
  // Package is mutable (Sui Move Registry `@kai/sav`, "config not constants")
  // → fetched by the mobile adapter, not carried on the target.
  | { kind: "kai-vault"; vault: string; coinType: string; shareType: string }
  // Current Finance (Sui) — isolated-market money market, DEPOSIT-ONLY.
  // `deposit::deposit<M,T>(app, &mut Market<M>, &ObligationOwnerCap, Coin<T>,
  // &Clock)` after `enter_market::enter_market_return<M>(app, &mut Market<M>)
  // -> ObligationOwnerCap` (created inline when the wallet doesn't already own
  // one for this market) — both device-verified atomic in one PTB, no oracle,
  // 2026-08-22. `app` (ProtocolApp) and `market` are stable shared objects;
  // `marketType` (M, e.g. `<pkg>::market_type::MainMarket`) is the isolated
  // market's phantom type, matched from `pool.poolMeta` (Current's own
  // `getMarketList` API — "MainMarket"/"EmberMarket"/etc.); `coinType` (T) ==
  // underlyingTokens[0]. A debt-free obligation cannot be liquidated, so
  // deposit carries no leverage risk despite the CDP shape.
  //
  // WITHDRAW is NOT wired: `withdraw::withdraw_as_coin` requires a LIVE Pyth
  // price pushed in the SAME transaction (verified against a real production
  // withdraw tx — vaa::parse_and_verify → pyth::create_authenticated_price_
  // infos_using_accumulator → pyth::update_single_price_feed →
  // user_oracle::refresh_usd_price → withdraw_as_coin). That's a genuine new
  // subsystem (Hermes fetch + VAA encoding) this codebase has never built for
  // ANY protocol — unlike Suilend, where the identical-looking "Pyth-gated"
  // claim turned out to be a stale-package false alarm, this one is real.
  | {
      kind: "current-market";
      app: string;
      market: string;
      marketType: string;
      coinType: string;
    }
  // Cetus CLMM (Sui) — concentrated-liquidity LP, FULL-RANGE ONLY,
  // SINGLE-ASSET DEPOSIT via an internal swap-split zap (deliberately NOT the
  // ember-vault/scallop-market shape: an LP position always needs BOTH legs,
  // so the mobile adapter reads the pool's live price, estimates a swap
  // split with `services/defi/adapters/sui/clmmMath.ts` — a from-scratch
  // `bigint` port of Cetus's own published formulas, cross-checked bit-exact
  // against their SDK before trusting it — swaps via the SAME pool
  // (`router::swap`, never an external router: guarantees the pair exists),
  // then `pool::open_position` + `pool::add_liquidity_fix_coin` (the
  // contract computes the exact second-leg amount itself; the off-chain
  // estimate only has to size the swap close enough — see `cetusSui.ts`).
  // `pool` is the resolved pool object; `coinTypeA`/`coinTypeB` are its two
  // legs in on-chain order (NOT necessarily underlyingTokens' order — the
  // resolver records both explicitly rather than assuming). `tickSpacing`
  // (from Cetus's own stats API, same row as the pool address) matters
  // because "full range" isn't one universal tick pair: `open_position`
  // rejects bounds that aren't multiples of the POOL's own tick_spacing
  // (found the hard way — a global ±443636 constant only happens to be valid
  // for a tick_spacing that divides it evenly; `clmmMath.ts`'s
  // `fullRangeTicksFor(tickSpacing)` rounds to the nearest valid multiple).
  // No oracle. Package is mutable, pinned in the mobile adapter's config —
  // see that file's header for exactly how it was verified (a real,
  // *successful*, current transaction, after an earlier pin turned out to be
  // a package that had been failing on every call for months — checking a
  // transaction merely EXISTS is not enough, `effects.status` must be
  // checked too). WITHDRAW is NOT wired (`remove_liquidity` + fee/reward
  // collection + `close_position` needs its own careful pass).
  | {
      kind: "cetus-clmm-pool";
      pool: string;
      coinTypeA: string;
      coinTypeB: string;
      tickSpacing: number;
    }
  // Turbos Finance CLMM (Sui) — same shape/reasoning as `cetus-clmm-pool`
  // (full-range only, single-asset zap-deposit) but a materially simpler
  // on-chain interface: `position_manager::mint` takes explicit `amountA`/
  // `amountB` (no hot-potato receipt/repay dance) and the mobile adapter
  // reads those back from the ACTUAL post-swap coin balances IN-PTB (chained
  // `coin::value` results), not an off-chain estimate — so there is no
  // fix-one-side/read-the-other-back step here at all. Ticks use a
  // (absValue:u32, isNegative:bool) pair, not Cetus's two's-complement u32.
  // Full-range bounds and the swap-split math are the SAME
  // `clmmMath.ts` (protocol-agnostic by design) already built for Cetus.
  // `coinTypeA`/`coinTypeB`/`feeType` are the pool's own 3 generic type
  // params (`Pool<A,B,Fee>` — Turbos parametrizes the fee tier as a TYPE, not
  // just a numeric field); `tickSpacing` and `pool` come straight off
  // Turbos's own public `/pools` stats API (`api2.turbos.finance`, the same
  // source DeFiLlama's own turbos adaptor reads). Package address is
  // mutable and fetched live by the mobile adapter from Turbos's own hosted
  // `contract.json` (a real "config not constants" endpoint, unlike Cetus
  // which has none) — never carried on the target. No oracle. WITHDRAW is
  // NOT wired (`decrease_liquidity` + `collect`/`collect_reward` + `burn`
  // needs its own pass, same as Cetus).
  | {
      kind: "turbos-clmm-pool";
      pool: string;
      coinTypeA: string;
      coinTypeB: string;
      feeType: string;
      tickSpacing: number;
    }
  // Bluefin Spot CLMM (Sui) — same shape/reasoning as `cetus-clmm-pool` (full
  // range only, single-asset zap-deposit) with its own mix of the two other
  // protocols' interfaces: `pool::open_position` takes just
  // (config, pool, tickLower, tickUpper) like Cetus (two's-complement u32
  // ticks, no separate bool), but `gateway::provide_liquidity_with_fixed_amount`
  // takes explicit amount/amountAMax/amountBMax like Turbos's `mint` (no
  // hot-potato receipt) — confirmed against 2 real, recent, successful
  // mainnet transactions (both function's argument order AND that the
  // liquidity call auto-refunds any unused offered balance to the sender
  // internally, verified via that transaction's own balanceChanges/
  // objectChanges, not just its success status). The internal swap-split
  // zap uses the LOW-LEVEL `pool::swap` (Balance<A>/Balance<B> in and out,
  // composable in one PTB) rather than the convenience
  // `gateway::swap_assets`, which was found (via a real transaction with no
  // disposal commands after it) to auto-transfer its output coins straight
  // to the sender — an "entry"-style function, not chainable into the same
  // PTB as the deposit. `coinTypeA`/`coinTypeB` are the pool's 2 generic
  // type params (fee tier is a numeric `fee_rate` FIELD here, not a type
  // param like Turbos); `tickSpacing` and `pool` come off Bluefin's own
  // public `/pools/info` stats API. Package address is mutable; the mobile
  // adapter pins it (no live-fetchable config endpoint exists for Bluefin
  // Spot, same gap as Cetus) — see that file's header for the verification
  // story. No oracle. WITHDRAW is NOT wired (`pool::remove_liquidity` +
  // `gateway::close_position` needs its own pass, same as Cetus/Turbos).
  | {
      kind: "bluefin-spot-pool";
      pool: string;
      coinTypeA: string;
      coinTypeB: string;
      tickSpacing: number;
    }
  | { kind: "solana-reserve"; program: string; reserve: string; mint: string }
  // Solana liquid staking — mirrors "sui-lst": one kind, dispatched by
  // `venue` to the mobile-twin config in
  // `services/defi/adapters/solana/lst.config.ts`. Keep the venue list in
  // sync with this file's `solana-lst.config.ts`.
  | { kind: "solana-lst-stake"; venue: string; poolMint: string }
  // Jupiter Lend Earn — single-asset vault family, mirrors "erc4626". Keep
  // in sync with the mobile twin in `services/defi/types.ts`.
  | { kind: "jupiter-lend-vault"; asset: string }
  // Kamino kvault ("Earn" share vaults) — the program behind DeFiLlama's
  // `sentora` project on Solana (a multi-chain aggregator brand, NOT unique
  // to Kamino; only its 2 Solana pools resolve here — see
  // `kamino-kvault.resolver.ts`). `vault`/`mint` come from the pinned venue
  // table in that resolver's config, since there is no public "list kvaults"
  // API. Keep in sync with the mobile twin in `services/defi/types.ts`.
  | { kind: "kamino-kvault"; vault: string; mint: string }
  // Raydium CPMM — self-contained constant-product AMM (not legacy AMM v4,
  // not CLMM). Keep in sync with the mobile twin in `services/defi/types.ts`.
  | { kind: "raydium-cpmm-pool"; pool: string; mintA: string; mintB: string }
  // Raydium legacy AMM v4 — OpenBook-market-linked constant-product. Keep in
  // sync with the mobile twin in `services/defi/types.ts`.
  | { kind: "raydium-amm-v4-pool"; pool: string; mintA: string; mintB: string }
  // Raydium legacy Stable Swap AMM (v5) — separate program from AMM v4, same
  // instruction shape plus one extra account. Keep in sync with the mobile
  // twin in `services/defi/types.ts`.
  | { kind: "raydium-stable-pool"; pool: string; mintA: string; mintB: string }
  // Kamino kliquidity — managed CLMM vault ("yvaults" on-chain), wraps an
  // Orca/Raydium/Meteora position. `strategy` is the on-chain
  // WhirlpoolStrategy account; `mintA`/`mintB` mirror the strategy's own
  // token ordering. Keep in sync with the mobile twin in
  // `services/defi/types.ts`.
  | {
      kind: "kamino-liquidity-strategy";
      strategy: string;
      mintA: string;
      mintB: string;
    }
  // Jito Restaking Vault deposit — the generic `MintTo` instruction on
  // Jito's public Vault program, currently resolved only for Kyros's kySOL
  // vault. `mint` is the vault's live `supported_mint` (JitoSOL, an SPL
  // token — NOT native SOL). DEPOSIT ONLY: withdraw on this program is a
  // two-step, epoch-cooldown ticket flow, not a single atomic action. Keep
  // in sync with the mobile twin in `services/defi/types.ts`.
  | { kind: "jito-vault-deposit"; vault: string; mint: string };

export type DepositTargetKind = DepositTarget["kind"];

/**
 * The EVM subset of `DepositTargetKind`. Every entry MUST have an explicit
 * on-chain validator — `validateTarget`'s `default: return true` passthrough
 * is removed for these (spec §8.1), so a new EVM kind that forgets its
 * validator is rejected rather than silently trusted. Non-EVM kinds keep
 * resolver-internal validation.
 */
export const EVM_TARGET_KINDS = [
  "erc4626",
  "aave-v3",
  "morpho-blue",
  "compound-v3",
  "compound-v2",
  "curve-lp",
  "solidly-lp",
  "uniswap-v2",
  "balancer-lp",
  "lst-stake",
  "router-call",
  "async-vault",
] as const satisfies readonly DepositTargetKind[];

export type EvmTargetKind = (typeof EVM_TARGET_KINDS)[number];

/**
 * Every NON-EVM kind, in the same spirit as `EVM_TARGET_KINDS` but with a
 * stronger guarantee: the assertion below makes `tsc` fail if a kind is added
 * to `DepositTarget` and to neither list. The EVM list is kept honest by a
 * spec test; this one cannot be forgotten, because forgetting it does not
 * compile.
 *
 * The point of naming these at all is `validation.ts`: a non-EVM kind used to
 * pass validation BY BEING non-EVM, which made "we never checked this" and
 * "this resolver checked it" the same answer.
 */
export const NON_EVM_TARGET_KINDS = [
  // Sui
  "scallop-market",
  "ember-vault",
  "navi-pool",
  "suilend-market",
  "sui-lst",
  "kai-vault",
  "current-market",
  "cetus-clmm-pool",
  "turbos-clmm-pool",
  "bluefin-spot-pool",
  // Solana
  "solana-reserve",
  "solana-lst-stake",
  "jupiter-lend-vault",
  "kamino-kvault",
  "raydium-cpmm-pool",
  "raydium-amm-v4-pool",
  "raydium-stable-pool",
  "kamino-liquidity-strategy",
  "jito-vault-deposit",
] as const satisfies readonly DepositTargetKind[];

export type NonEvmTargetKind = (typeof NON_EVM_TARGET_KINDS)[number];

/**
 * Compile-time exhaustiveness. A new `DepositTarget` member that lands in
 * neither list makes the constant below an error, naming the kind that was
 * forgotten.
 *
 * The tuple wrapper is load-bearing: `T extends never ? …` DISTRIBUTES over a
 * naked type parameter, so the obvious spelling silently evaluates to `never`
 * and asserts nothing. (The first version of this guard was written as
 * `const _: Unclassified[] = []` and proved worthless for the same family of
 * reason — an empty array satisfies every array type. Verified by adding a
 * junk kind and watching `tsc` stay green.)
 */
type IsNever<T> = [T] extends [never] ? true : false;
type UnclassifiedTargetKind = Exclude<
  DepositTargetKind,
  EvmTargetKind | NonEvmTargetKind
>;
export const _everyTargetKindIsClassified: IsNever<UnclassifiedTargetKind> =
  true;

export function isEvmTargetKind(
  kind: DepositTargetKind,
): kind is EvmTargetKind {
  return (EVM_TARGET_KINDS as readonly string[]).includes(kind);
}

/**
 * One resolver per protocol *family*, registered in the target registry
 * (spec §5). Mirrors the mobile space-docking pattern: adding a protocol is a
 * `registerResolver(...)` call, NEVER a `switch` on project slug.
 *
 * `resolve` MUST fail closed — return `null` (→ manual) whenever it cannot
 * confidently resolve *and* on-chain-validate a target. Never guess an address.
 */
export interface PoolTargetResolver {
  /** Canonical family key (e.g. "morpho", "yearn", "aave"). */
  readonly family: string;
  /**
   * DeFiLlama `project` slugs (and shorthands) this resolver handles, matched
   * case-insensitively against `pool.project`. When omitted, only `family`
   * matches.
   */
  readonly aliases?: readonly string[];
  resolve(
    pool: DeFiLlamaYieldPool,
    ctx: ResolverContext,
  ): Promise<DepositTarget | null>;
}

/**
 * Injected capabilities a resolver needs — kept as an interface so resolvers
 * stay plain, testable functions (no Nest DI inside the family files).
 */
export interface FetchJsonInit<T> {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cacheIf?: (body: T) => boolean;
}

export interface ResolverContext {
  /**
   * TTL-cached, deduped JSON GET (Valkey-backed). Returns `null` on failure.
   * `cacheIf` keeps a 2xx body that is not an answer yet (a "pending") out of
   * the cache, so it is asked again next time instead of for the whole TTL.
   */
  fetchJsonCached<T>(
    cacheKey: string,
    url: string,
    ttlSec: number,
    init?: FetchJsonInit<T>,
  ): Promise<T | null>;
  /** On-chain validation (spec §3.2). Returns false when it can't confirm. */
  validate(target: DepositTarget, pool: DeFiLlamaYieldPool): Promise<boolean>;
  /**
   * A read-only client for an EVM chain, or `null` when we cannot reach it.
   *
   * Resolution details that only the chain knows — a Curve pool's `coins[]`
   * arity and index type, a Solidly pool's `stable` flag, a Balancer pool's
   * registration id — are read HERE rather than fetched from the protocol's
   * API. That keeps them out of §11 Layer-6's "untrusted external data"
   * category entirely: chain state cannot be spoofed by a compromised API, and
   * the read happens once at resolve time so the adapter never has to probe
   * per build (§3.3).
   *
   * Optional so existing resolvers and their fixtures are unaffected; a
   * resolver that needs it and doesn't get it fails closed to Manual.
   */
  publicClient?(chainId: number): EvmReadClient | null;
}

/**
 * The narrow slice of viem's `PublicClient` resolvers are allowed to use:
 * reads only. Typed structurally so tests can pass a stub without pulling
 * viem's full client type in.
 */
export interface EvmReadClient {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBytecode?(args: { address: Address }): Promise<string | undefined>;
  /**
   * Batched reads. Optional so a stubbed client in a spec need not implement
   * it — callers fall back to sequential `readContract`.
   *
   * Needed by the candidate sources that enumerate a protocol's own on-chain
   * registry: Euler lists ~900 vaults, and asking each one for `asset()` in a
   * separate round trip is not something to do inside a scoring loop.
   */
  multicall?(args: {
    contracts: readonly {
      address: Address;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }[];
    multicallAddress?: Address;
    allowFailure?: boolean;
  }): Promise<readonly { status: "success" | "failure"; result?: unknown }[]>;
}

/**
 * DeFiLlama chain name → EVM chainId.
 *
 * Chain support is **data-driven** — the mapping comes from the `Blockchain`
 * table via `chain-directory.ts`, never a literal in this file. Coverage in
 * this spec scales by execution *family*, so a resolver must reach every EVM
 * chain a family is deployed on; that set is whatever ops has seeded, and
 * adding one is a row plus an rpc-proxy route. Unknown/unloaded → `0` → the
 * resolver fails closed to Manual.
 *
 * Re-exported here so the ~20 existing `from "./types"` imports keep working.
 */
export { resolveEvmChainId } from "./chain-directory";

/** Lowercased 0x-address compare that tolerates undefined / non-hex. */
export function eqAddr(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** The deposited asset address from `/pools`, lowercased. */
export function underlyingOf(pool: DeFiLlamaYieldPool): string | null {
  const t = pool.underlyingTokens?.[0];
  return typeof t === "string" && /^0x[0-9a-fA-F]{40}$/.test(t)
    ? t.toLowerCase()
    : null;
}
