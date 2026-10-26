/**
 * Tier 1 — widening the ERC-4626 funnel (spec §4).
 *
 * **No new adapter, no new kind.** Every protocol here is a native ERC-4626
 * vault, so the whole job is turning the DeFiLlama pool's matching keys into
 * `{ kind:"erc4626", vault, asset }` and letting the shipped `Erc4626Adapter`
 * execute it. Two resolver shapes cover the catalog:
 *
 *  1. **Pinned** (`pinnedVaultResolver`) — protocols with exactly ONE canonical
 *     savings vault per token per chain (Sky/Spark `sUSDS`/`sDAI`, Origin's
 *     wrapped tokens). The address IS the identity, so it comes from the
 *     reviewed address-book and no third party is consulted at all.
 *
 *  2. **Discovered** (`discoveredVaultResolver`) — multi-vault protocols
 *     (Euler EVK evaults, Fluid `fToken`s, Gearbox v3 passive pools, Concrete,
 *     Venus's ERC-4626 wrappers). §12 Q1 decided these need **no bespoke
 *     gating**: a candidate is admitted iff `validateErc4626` passes
 *     (`asset()` matches, the 4626 selector set responds, TVL band). So the
 *     resolver only has to produce a candidate address — the on-chain proof is
 *     the verification, and it is stronger than any allowlist we could write.
 *
 * Both fail closed to `null` → Manual (§8.2). Neither introduces a `switch` on
 * `pool.project`: a new 4626 protocol is one `registerResolver` line with its
 * slugs, nothing else.
 */

import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { type PinnedVault, pinnedVaults } from "./address-book";
import {
  candidateForPool,
  independentSourcesAgree,
} from "./candidates/registry";
import type {
  Address,
  DepositTarget,
  PoolTargetResolver,
  ResolverContext,
} from "./types";
import { eqAddr, resolveEvmChainId, underlyingOf } from "./types";

/**
 * A protocol whose vaults are pinned in the address-book. Matching is
 * `(chain, underlyingTokens[0])` against the book — a pool for a token the
 * protocol has no reviewed vault for resolves to nothing.
 */
/** Case/punctuation-insensitive identity for a ticker comparison. */
function normaliseTicker(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The one vault in `candidates` whose label the pool row names exactly, or
 * `null` if that is zero or more than one.
 *
 * `null` is a refusal, and refusing is the correct outcome: two reviewed
 * vaults over one asset and nothing in the row to tell them apart means we do
 * not know where the user's money should go.
 */
function uniqueByLabel(
  candidates: readonly PinnedVault[],
  pool: DeFiLlamaYieldPool,
): PinnedVault | null {
  const needles = new Set(
    [pool.symbol, pool.poolMeta]
      .filter((v): v is string => !!v?.trim())
      .map(normaliseTicker),
  );
  if (needles.size === 0) return null;
  const hits = candidates.filter((c) => needles.has(normaliseTicker(c.label)));
  return hits.length === 1 ? hits[0] : null;
}

export function pinnedVaultResolver(config: {
  family: string;
  aliases: readonly string[];
  /** Address-book key; defaults to `family`. */
  book?: string;
  /**
   * "This row is not a deposit at all" — the same escape hatch
   * `discoveredVaultResolver` has, and needed for the same reason.
   *
   * Without it a pinned family refuses a non-deposit row only as a SIDE EFFECT
   * of the book happening not to pin a vault for that row's asset. That holds
   * until someone pins one, and then a borrow-side or collateral row resolves
   * into a supply vault. It is the `aave-v4` reasoning one level down: relying
   * on "the candidate we happen to get is wrong" rather than on a rule.
   */
  skipPool?(pool: DeFiLlamaYieldPool): boolean;
}): PoolTargetResolver {
  const bookKey = config.book ?? config.family;
  return {
    family: config.family,
    aliases: config.aliases,
    async resolve(pool, ctx): Promise<DepositTarget | null> {
      if (config.skipPool?.(pool)) return null;
      const chainId = resolveEvmChainId(pool.chain);
      if (!chainId) return null;
      const underlying = underlyingOf(pool);
      if (!underlying) return null;

      const candidates = pinnedVaults(bookKey, chainId).filter((v) =>
        eqAddr(v.asset, underlying),
      );
      if (candidates.length === 0) return null;

      // One reviewed vault for this token is the common case and needs no
      // disambiguation at all.
      //
      // More than one is legitimate — Sky ships both `sUSDS` and `stUSDS` over
      // USDS — but it used to be an automatic refusal, which would have taken
      // the ~$4.66B sUSDS pool down with the new one. The discriminator is the
      // vault's own TICKER against the row's `symbol`/`poolMeta`, matched
      // EXACTLY and required to be unique.
      //
      // Deliberately not fuzzy. `hay.includes(needle)` on a shared symbol is
      // what routed 25 Morpho pools into the wrong vault (§11.6b), and a book
      // that cannot say which vault a row means must refuse rather than pick.
      const chosen =
        candidates.length === 1
          ? candidates[0]
          : uniqueByLabel(candidates, pool);
      if (!chosen) return null;

      const target: DepositTarget = {
        kind: "erc4626",
        vault: chosen.vault.toLowerCase() as Address,
        asset: underlying as Address,
      };
      return (await ctx.validate(target, pool)) ? target : null;
    },
  };
}

/**
 * A multi-vault ERC-4626 protocol with no registry we can stand behind. The
 * candidate address comes from DeFiLlama's legacy pool id
 * (`defillama-pool-address.ts`) and is admitted only by on-chain proof.
 *
 * `minTvlUsd` is a cheap pre-filter, not a safety control — the real gate is
 * `ctx.validate`. It keeps dust pools out of the RPC budget.
 */
export function discoveredVaultResolver(config: {
  family: string;
  aliases: readonly string[];
  minTvlUsd?: number;
  /**
   * "This row is not a deposit at all." Some protocols publish one DeFiLlama
   * row per SIDE of a market, and the borrow side is not something a user can
   * supply into — Curve LlamaLend emits a second row per vault whose
   * `underlyingTokens` is the COLLATERAL.
   *
   * That has to be refused before a candidate is even requested, because the
   * collateral of one market is very often the borrowed asset of another: a
   * borrow row could find a real, validating 4626 vault belonging to a
   * DIFFERENT market and the user would deposit into it. Relying on "the
   * candidate we happen to get back is not 4626" is the same reasoning that
   * let `aave-v4` route onto the v3 Pool.
   */
  skipPool?(pool: DeFiLlamaYieldPool): boolean;
}): PoolTargetResolver {
  const minTvl = config.minTvlUsd ?? 0;
  return {
    family: config.family,
    aliases: config.aliases,
    async resolve(
      pool: DeFiLlamaYieldPool,
      ctx: ResolverContext,
    ): Promise<DepositTarget | null> {
      if (config.skipPool?.(pool)) return null;
      const chainId = resolveEvmChainId(pool.chain);
      if (!chainId) return null;
      const underlying = underlyingOf(pool);
      if (!underlying) return null;
      if (pool.tvlUsd < minTvl) return null;

      const answer = await candidateForPool(pool, ctx);
      if (!answer) return null;
      // A vault's catalog key IS the vault, so every vault-keyed source can
      // judge this answer; two that disagree mean one is wrong about where the
      // money goes, and neither is believed.
      if (!(await independentSourcesAgree(pool, ctx, answer))) return null;
      const vault = answer.address;

      const target: DepositTarget = {
        kind: "erc4626",
        vault,
        asset: underlying as Address,
      };
      // §12 Q1: the validator IS the verification. A vault that is not really
      // 4626, or whose asset() disagrees with the pool's underlying, fails
      // here and the pool keeps its honest "Manual" badge.
      return (await ctx.validate(target, pool)) ? target : null;
    },
  };
}

// ── Pinned single-vault savings protocols ──────────────────────────────────

/**
 * Maker/Sky publish a DeFiLlama row per **ilk** — a CDP collateral type, named
 * by the `<SYMBOL>-<LETTER>` convention (`ETH-A`, `WSTETH-B`, `WBTC-C`).
 *
 * Those rows are not deposits. Their `underlyingTokens` is the collateral a
 * user LOCKS in order to borrow USDS, so supplying into a savings vault for
 * that same token is a different action entirely, and leveraged/borrow
 * positions are out of scope by design (§1 non-goals). Measured 2026-08-21:
 * seven such rows, ~$1.7B.
 *
 * They refuse today anyway, because the `sky` book pins no WETH/WBTC/wstETH
 * vault for a candidate to match. That is luck, not a rule — the day one is
 * pinned, a CDP row would resolve into a supply vault and validate cleanly,
 * because the asset genuinely matches. Refusing by NAME, before a candidate is
 * requested, is what §11.5c asks for.
 *
 * "SKY Staking Engine" is excluded on the same ground: a staking product, not a
 * savings vault.
 */
const MAKER_ILK_META = /^[A-Z0-9]+-[A-Z]$/;

export function isSkyNonDepositRow(pool: DeFiLlamaYieldPool): boolean {
  const meta = pool.poolMeta?.trim();
  if (!meta) return false;
  return MAKER_ILK_META.test(meta) || /staking engine/i.test(meta);
}

/**
 * Sky Savings — `sUSDS` is the Sky Savings Rate token. Stablecoin-native, so it
 * lines up with the product's payments thesis rather than being yet another
 * yield venue.
 */
export const SkySavingsResolver = pinnedVaultResolver({
  family: "sky",
  aliases: ["sky-lending", "sky", "makerdao", "maker-dsr", "sky-savings"],
  book: "sky",
  skipPool: isSkyNonDepositRow,
});

/**
 * Spark savings — exposes the SAME `sUSDS`/`sDAI` contracts Sky does
 * (docs.spark.fi: "ERC-4626 representation of USDS/DAI"), so it shares the
 * book. SparkLend (the Aave-v3-fork money market) is a different product and
 * resolves through the Family-B fork resolver instead.
 */
export const SparkSavingsResolver = pinnedVaultResolver({
  family: "spark-savings",
  aliases: ["spark-savings", "spark-dai", "susds", "sdai"],
  book: "spark",
});

/** Origin — only the wrapped, non-rebasing receipts are 4626. */
export const OriginResolver = pinnedVaultResolver({
  family: "origin",
  aliases: ["origin-dollar", "origin-ether", "origin-defi", "origin"],
  book: "origin",
});

// ── Multi-vault 4626 protocols admitted by on-chain proof (§12 Q1) ─────────

/** Euler v2 — EVK "EVaults are (mostly) standard-conforming ERC-4626". */
export const EulerResolver = discoveredVaultResolver({
  family: "euler",
  aliases: ["euler-v2", "euler", "eulerv2", "euler-finance"],
  minTvlUsd: 250_000,
});

/** Fluid lending — supply to Liquidity through ERC-4626-compliant `fToken`s. */
export const FluidResolver = discoveredVaultResolver({
  family: "fluid",
  aliases: ["fluid-lending", "fluid", "instadapp-fluid", "fluid-dex-lite"],
  minTvlUsd: 250_000,
});

/** Gearbox v3 — the passive LP side of a credit pool is 4626. */
export const GearboxResolver = discoveredVaultResolver({
  family: "gearbox",
  aliases: ["gearbox", "gearbox-v3", "gearbox-passive"],
  minTvlUsd: 250_000,
});

/** Concrete — capital-allocator vaults; 4626 conformance proven on-chain. */
export const ConcreteResolver = discoveredVaultResolver({
  family: "concrete",
  aliases: ["concrete", "concrete-earn"],
  minTvlUsd: 250_000,
});

/**
 * Venus's ERC-4626 wrapper vaults. §12 Q3: **prefer the wrapper** over the raw
 * `vToken` when one exists, because it reuses the hardened 4626
 * adapter/validator instead of the bespoke Compound-v2 path. Registered ahead
 * of the `compound-v2` Venus resolver so the wrapper is tried first; when no
 * wrapper exists for a market this returns null and the cToken resolver takes
 * over.
 */
export const Venus4626Resolver = discoveredVaultResolver({
  family: "venus-4626",
  // Shares Venus's DeFiLlama slugs on purpose: both resolvers claim the same
  // pools, and registration order decides which is tried first.
  aliases: [
    "venus-erc4626",
    "venus-4626",
    "venus-core-pool",
    "venus-isolated-pools",
    "venus",
  ],
  minTvlUsd: 250_000,
});

/**
 * Curve LlamaLend — its LENDING vaults are ERC-4626, unlike Curve's LP pools
 * (which are Family G / `curve-lp`). Same protocol name, different family:
 * routing by the pool's actual ABI rather than the brand is the whole point of
 * the family model.
 */
export const CurveLlamaLendResolver = discoveredVaultResolver({
  family: "curve-llamalend",
  aliases: ["curve-llamalend", "llamalend"],
  minTvlUsd: 250_000,
  // DeFiLlama publishes TWO rows per LlamaLend vault: the lend side, whose
  // `poolMeta` is "<collateral> collateral", and the borrow side, whose
  // `poolMeta` is "<borrowed> borrow" and whose `underlyingTokens` is the
  // collateral. Only the lend side is a deposit. The suffix is DeFiLlama's own
  // construction, not ours — `yield-server/src/adaptors/curve-llamalend/index.js`
  // builds it as `borrowed.symbol + ' borrow'` (read 2026-08-21).
  skipPool: (pool) => /\bborrow$/i.test(pool.poolMeta ?? ""),
});

/** Every Tier-1 Family-A resolver, in registration order. */
export const TIER1_ERC4626_RESOLVERS: readonly PoolTargetResolver[] = [
  SkySavingsResolver,
  SparkSavingsResolver,
  OriginResolver,
  EulerResolver,
  FluidResolver,
  GearboxResolver,
  ConcreteResolver,
  Venus4626Resolver,
  CurveLlamaLendResolver,
];
