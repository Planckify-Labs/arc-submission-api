/**
 * Resolver bootstrap (pool-level spec §5.1, expansion spec §8.6).
 *
 * Registration order is load-bearing in one place only: §12 Q3 wants a
 * protocol's ERC-4626 wrapper tried before its raw cToken, so `venus-4626`
 * registers ahead of `venus`. Everything else is order-independent — the
 * registry routes by `family`/`aliases`, never by position.
 *
 * Adding a protocol is one `registerResolver(...)` here plus its one-file
 * resolver. No branch anywhere.
 *
 * **Tier flags default OFF** (see feature-flags.ts): a family goes live only
 * once its Layer-1 validator, Layer-4 decode assertion and Layer-5 pause check
 * are fork-tested (§11.3) and its pinned addresses have security sign-off
 * (§12 Q7). The flags gate BOTH sides — the mobile adapter registration is
 * gated by the twin flags in `mobile-app/constants/configs/featureFlags.ts`, so
 * a half-wired family never badges "Deposit in-app".
 */

import { TIER1_AAVE_FORK_RESOLVERS } from "./aave-fork.resolver";
import { AaveResolver } from "./aave.resolver";
import { TIER3_BALANCER_RESOLVERS } from "./balancer.resolver";
import { BluefinSpotResolver } from "./bluefin.resolver";
import { ONCHAIN_CANDIDATE_SOURCES } from "./candidates/onchain.source";
import {
  MarketPoolAddressSource,
  marketApiConfig,
} from "./candidates/market-pool-address.source";
import { registerCandidateSource } from "./candidates/registry";
import { CetusResolver } from "./cetus.resolver";
import { TIER2_COMPOUND_RESOLVERS } from "./compound.resolver";
import { CurrentResolver } from "./current.resolver";
import { CurveResolver } from "./curve.resolver";
import {
  PoolUrlCandidateSource,
  PoolsOldCandidateSource,
} from "./defillama-pool-address";
import { EmberResolver } from "./ember.resolver";
import { TIER1_ERC4626_RESOLVERS } from "./erc4626-family.resolver";
import { AaveV4Resolver } from "./aave-v4.resolver";
import { MorphoResolver, YearnResolver } from "./erc4626.resolver";
import {
  familyEnabled,
  isFamilyKilled,
  nonEvmFamilyEnabled,
} from "./feature-flags";
import { JitoVaultResolver } from "./jito-vault.resolver";
import { JupiterLendResolver } from "./jupiter-lend.resolver";
import { KaiResolver } from "./kai.resolver";
import { KaminoKvaultResolver } from "./kamino-kvault.resolver";
import { KaminoLendResolver } from "./kamino-lend.resolver";
import { KaminoLiquidityResolver } from "./kamino-liquidity.resolver";
import { LstStakeResolver } from "./lst.resolver";
import { MorphoBlueResolver } from "./morpho-blue.resolver";
import { NaviResolver } from "./navi.resolver";
import { bootProtocolManifests } from "./protocol-manifest";
import { RaydiumAmmV4Resolver } from "./raydium-amm-v4.resolver";
import { RaydiumCpmmResolver } from "./raydium-cpmm.resolver";
import { RaydiumStableResolver } from "./raydium-stable.resolver";
import { TurbosResolver } from "./turbos.resolver";
import "./protocols";
import { TIER4_CENTRIFUGE_RESOLVERS } from "./centrifuge.resolver";
import { registerResolver } from "./registry";
import { TIER3_ROUTER_CALL_RESOLVERS } from "./router-call.resolver";
import { ScallopResolver } from "./scallop.resolver";
import { SolanaLstResolver } from "./solana-lst.resolver";
import { TIER3_SOLIDLY_RESOLVERS } from "./solidly.resolver";
import { SuilendResolver } from "./suilend.resolver";
import { SuiLstResolver } from "./suilst.resolver";
import type { PoolTargetResolver } from "./types";
import { TIER3_UNISWAP_V2_RESOLVERS } from "./uniswap-v2.resolver";

let booted = false;

/**
 * Candidate-address sources (spec §4, §12 Q1).
 *
 * Order is load-bearing: a protocol's OWN on-chain registry is consulted before
 * the generic DeFiLlama fallback, so the answer comes from the deployment
 * rather than from an aggregator that can be paywalled — which is exactly what
 * happened to `/poolsOld`, silently disabling seven families at once.
 *
 * NOT gated by the tier flags. A candidate source cannot route funds anywhere
 * on its own: the resolver's validator still has to prove the address, and a
 * wrong candidate fails closed to Manual. Gating discovery would only make the
 * dry run lie about what a tier would resolve.
 */
function bootCandidateSources(): void {
  for (const source of ONCHAIN_CANDIDATE_SOURCES) {
    registerCandidateSource(source);
  }
  // `/poolsOld` is registered ONLY with a pro key. Without one it is HTTP 402
  // (verified 2026-08-19), and a source we know answers nothing does not belong
  // in the fallback chain: it would sit there looking like coverage, which is
  // precisely the failure mode the discovery-health check exists to catch.
  if (process.env.DEFILLAMA_PRO_API_KEY?.trim()) {
    registerCandidateSource(PoolsOldCandidateSource);
  }
  // Our market API: pool id -> contract from the protocol's own adapter run,
  // joined exactly (UUIDv5) or by a unique attribute match. Ahead of the deep
  // link, which only some protocols carry an address in. Registered only when
  // configured, for the same reason as `/poolsOld` above.
  if (marketApiConfig()) {
    registerCandidateSource(MarketPoolAddressSource);
  }
  // The free replacement. Last, so a protocol's own registry always wins over
  // an aggregator's deep link.
  registerCandidateSource(PoolUrlCandidateSource);
}

/**
 * Register a family only when its tier flag AND its own sub-flag are on, and
 * ops has not tripped the kill-switch for it. One helper so every expansion
 * family is gated identically — a family that forgets its gate is the exact
 * mistake §11.3 forbids.
 */
function registerGated(
  tier: "tier1" | "tier2" | "tier3" | "tier4",
  resolvers: readonly PoolTargetResolver[],
): void {
  for (const resolver of resolvers) {
    if (!familyEnabled(tier, resolver.family)) continue;
    if (isFamilyKilled(resolver.family)) continue;
    registerResolver(resolver);
  }
}

/**
 * Register a Sui/Solana family, subject to its own sub-flag and the SAME
 * `isFamilyKilled` kill-switch every EVM family answers to.
 *
 * Non-EVM families are live rather than staged, so there is no tier gate here
 * and the sub-flag defaults ON — the value is having a switch at all. Before
 * this, a Sui or Solana protocol could only be disabled by shipping a release,
 * which is the wrong tool for an exploit disclosed at 3am.
 */
function registerNonEvm(
  namespace: "sui" | "solana",
  resolver: PoolTargetResolver,
): void {
  if (!nonEvmFamilyEnabled(namespace, resolver.family)) return;
  if (isFamilyKilled(resolver.family)) return;
  registerResolver(resolver);
}

export function bootTargetResolvers(): void {
  if (booted) return;
  bootCandidateSources();
  registerResolver(MorphoResolver);
  registerResolver(AaveV4Resolver);
  registerResolver(YearnResolver);
  registerResolver(AaveResolver);
  // Sui — Ember Vaults (generic tokenized-vault family; multi-vault, so the
  // resolver disambiguates siblings by poolMeta ↔ vault name). Emits
  // `{ kind: "ember-vault" }` for the mobile EmberSuiAdapter (Phase 3).
  registerNonEvm("sui", EmberResolver);
  // Sui — Scallop (single-market-per-asset). Emits `{ kind: "scallop-market" }`
  // for the existing ScallopSuiAdapter, so scallop-lend pools badge "Deposit
  // in-app" instead of resolving to nothing (Phase 3).
  registerNonEvm("sui", ScallopResolver);
  // Sui — NAVI (single-market-per-asset, coinType-matched via its pools API).
  // Emits `{ kind: "navi-pool" }` for the mobile NaviSuiAdapter (Phase 3).
  registerNonEvm("sui", NaviResolver);
  // Sui — liquid staking (Haedal / Volo / SpringSui / Aftermath). Emits
  // `{ kind: "sui-lst" }` for the mobile SuiLstAdapter. The pools these match
  // are synthesized by `SuiLstSource` (absent from DeFiLlama's Sui feed).
  registerNonEvm("sui", SuiLstResolver);
  // Sui — Suilend (single-market-per-asset). Emits `{ kind: "suilend-market" }`
  // for the mobile SuilendSuiAdapter. Was withheld for a reason that turned out
  // to be wrong ("Pyth-gated" — corrected 2026-08-22, see suilendSui.ts's file
  // header): the actual blocker was a stale moveCall package derived from the
  // market type's immutable address, now fixed via an on-chain UpgradeCap read
  // (suilend.config.ts, mobile). Deposit is device-verified via
  // sui_devInspectTransactionBlock against live mainnet; withdraw stays
  // deferred pending its own verification, independent of this resolver.
  registerNonEvm("sui", SuilendResolver);
  // Sui — Kai Finance Single Asset Vaults (generic tokenized vault, own
  // package — not Ember's or Suilend's). Emits `{ kind: "kai-vault" }` for
  // the mobile KaiSuiAdapter. Deposit AND withdraw both device-verified via
  // sui_devInspectTransactionBlock chained atomically in one PTB against live
  // mainnet 2026-08-22, no oracle either direction (kai.resolver.ts).
  registerNonEvm("sui", KaiResolver);
  // Sui — Current Finance (isolated-market money market, 5 markets). Emits
  // `{ kind: "current-market" }` for the mobile CurrentSuiAdapter.
  // DEPOSIT-ONLY: withdraw needs a live Pyth push in-tx (a real, new
  // subsystem — see types.ts's `current-market` comment; this is NOT the
  // same false alarm Suilend had). Deposit device-verified via
  // sui_devInspectTransactionBlock against live mainnet 2026-08-22 —
  // creating the obligation and depositing chain atomically in one PTB.
  registerNonEvm("sui", CurrentResolver);
  // Sui — Cetus CLMM (concentrated liquidity, full-range only). Emits
  // `{ kind: "cetus-clmm-pool" }` for the mobile CetusSuiAdapter. Deposit is
  // a swap-split zap into both legs (own-pool swap, never external) — see
  // types.ts's `cetus-clmm-pool` comment. WITHDRAW is not wired.
  registerNonEvm("sui", CetusResolver);
  // Sui — Turbos Finance CLMM (concentrated liquidity, full-range only).
  // Emits `{ kind: "turbos-clmm-pool" }` for the mobile TurbosSuiAdapter.
  // Same swap-split-zap deposit shape as Cetus, simpler on-chain interface
  // (explicit amountA/amountB, no hot-potato receipt) — see types.ts's
  // `turbos-clmm-pool` comment. WITHDRAW is not wired.
  registerNonEvm("sui", TurbosResolver);
  // Sui — Bluefin Spot CLMM (concentrated liquidity, full-range only).
  // Emits `{ kind: "bluefin-spot-pool" }` for the mobile BluefinSpotSuiAdapter.
  // Same swap-split-zap deposit shape as Cetus/Turbos — see types.ts's
  // `bluefin-spot-pool` comment. WITHDRAW is not wired.
  registerNonEvm("sui", BluefinSpotResolver);
  // Solana — liquid staking (Jito / JupSOL / dSOL / Marinade). Emits
  // `{ kind: "solana-lst-stake" }` for the mobile SolanaLstAdapter. These are
  // real DeFiLlama `/pools` rows (unlike the synthesized Sui LST venues).
  // Closes the exact Lido-shaped gap (§11.6a): Jito shipped a complete
  // adapter since Phase 2 with no resolver ever claiming its slug, so it
  // rendered as manual the entire time.
  registerNonEvm("solana", SolanaLstResolver);
  // Solana — Jupiter Lend Earn (single-asset vault family, mirrors the
  // `erc4626` shape). Emits `{ kind: "jupiter-lend-vault" }` for the mobile
  // JupiterLendAdapter. `jupiter-lend`'s DeFiLlama rows mix Earn vaults with
  // Borrow isolated-market rows sharing the same project slug — the resolver
  // refuses anything not tagged `poolMeta === "Earn"` before requesting a
  // candidate (jupiter-lend.resolver.ts's header has the measured counts).
  registerNonEvm("solana", JupiterLendResolver);
  // Solana — Kamino Lend (single-asset reserve deposits, obligation-based).
  // Emits `{ kind: "solana-reserve" }` for the mobile KaminoLendAdapter.
  // DeFiLlama's public `pool` field is a synthetic UUID, not the reserve
  // address, so the resolver recovers it by joining Kamino's own API on
  // market name + underlying mint — see kamino-lend.resolver.ts's header.
  registerNonEvm("solana", KaminoLendResolver);
  // Solana — Kamino kvault ("Earn" share vaults). Emits
  // `{ kind: "kamino-kvault" }` for the mobile KaminoKvaultAdapter.
  // DeFiLlama surfaces both known instances under the multi-chain `sentora`
  // project (not unique to Kamino) — see kamino-kvault.resolver.ts's header
  // for why this is a pinned, poolMeta-matched venue table rather than a
  // discovery join.
  registerNonEvm("solana", KaminoKvaultResolver);
  // Solana — Kamino kliquidity (managed CLMM vault). Emits
  // `{ kind: "kamino-liquidity-strategy" }` for the mobile
  // KaminoLiquidityAdapter. DeFiLlama's `poolMeta` is always null for this
  // project, so the resolver recovers the strategy address by joining
  // Kamino's own `/strategies` + `/strategies/metrics` APIs on the mint
  // pair, disambiguating by nearest match to the pool's own `tvlUsd` — see
  // kamino-liquidity.resolver.ts's header. Deliberately claims strategies on
  // ALL underlying DEXes (Orca/Raydium/Meteora) and both share-calculation
  // methods; the mobile adapter is what actually restricts to a verified
  // subset, failing closed to Manual for the rest.
  registerNonEvm("solana", KaminoLiquidityResolver);
  // Solana — Raydium CPMM (self-contained constant-product AMM, no zap, MAX-
  // only withdraw). Emits `{ kind: "raydium-cpmm-pool" }` for the mobile
  // RaydiumCpmmAdapter. DeFiLlama's `raydium-amm` project also carries
  // legacy AMM v4 and CLMM pools under the SAME slug — this resolver claims
  // only the "Standard" CPMM ones (see raydium-cpmm.resolver.ts's header),
  // recovering the real pool address by joining Raydium's own
  // `/pools/info/mint` API on the pool's mint pair, same disambiguation
  // discipline as KaminoLendResolver.
  registerNonEvm("solana", RaydiumCpmmResolver);
  // Solana — Raydium legacy AMM v4 (OpenBook-linked, the majority of real
  // "Standard" raydium-amm TVL). Claims the SAME `raydium-amm` alias as
  // RaydiumCpmmResolver above — registered second on purpose, so a mint
  // pair with BOTH a CPMM and an AMM v4 pool resolves through CPMM first
  // (see raydium-amm-v4.resolver.ts's header for why the two don't
  // actually compete in practice).
  registerNonEvm("solana", RaydiumAmmV4Resolver);
  // Solana — Raydium legacy Stable Swap AMM ("version 5", a program
  // separate from AMM v4). Same `raydium-amm` alias set, registered third —
  // the three resolvers never compete, each claims a different program id
  // (see raydium-stable.resolver.ts's header).
  registerNonEvm("solana", RaydiumStableResolver);
  // Solana — Jito Restaking Vault deposit (Kyros's kySOL vault). Emits
  // `{ kind: "jito-vault-deposit" }` for the mobile JitoVaultDepositAdapter.
  // Deposit only — see jito-vault.resolver.ts's header and the mobile
  // adapter's header for why withdraw (a two-step, epoch-cooldown ticket
  // flow on this program) is not wired.
  registerNonEvm("solana", JitoVaultResolver);

  // ── Tier 1 — widen the existing funnels. No new adapter, no new kind. ────
  // Family A (ERC-4626) first so a protocol that ships BOTH a 4626 wrapper and
  // a raw cToken market resolves through the hardened 4626 path (§12 Q3).
  registerGated("tier1", TIER1_ERC4626_RESOLVERS);
  // Family B (Aave-v3 forks) — resolver only, reuses the Aave adapter.
  registerGated("tier1", TIER1_AAVE_FORK_RESOLVERS);

  // ── Tier 2 — the declared-but-empty kinds get their adapters. ────────────
  registerGated("tier2", TIER2_COMPOUND_RESOLVERS);
  registerGated("tier2", [MorphoBlueResolver]);
  registerGated("tier2", [CurveResolver]);

  // ── Tier 3 — bespoke families. ──────────────────────────────────────────
  // Pendle only. The Uniswap v3/v4 resolvers exist and validate, but the
  // router-quote proxy has no Uniswap encoder: a concentrated-liquidity
  // position needs a tick range, which is a different product decision from
  // "supply this asset", and a guessed default range is a real position with
  // real losses. Registering them would badge pools the app cannot execute.
  registerGated(
    "tier3",
    TIER3_ROUTER_CALL_RESOLVERS.filter((r) => r.family === "pendle"),
  );
  registerGated("tier3", TIER3_SOLIDLY_RESOLVERS);
  registerGated("tier3", TIER3_UNISWAP_V2_RESOLVERS);
  registerGated("tier3", [LstStakeResolver]);
  // Balancer v2 / Beets — `BalancerQueries` is now pinned per chain
  // (address-book/dex.ts, verified against `balancer/balancer-deployments`,
  // 2026-08-19), so both sides can price `minimumBPT`/`minAmountsOut` instead
  // of guessing (§12 Q4 forbids a zero minimum). Each resolver still carries
  // its own `FEATURE_DEFI_EVM_FAMILY_BALANCER` / `_BEETS` sub-flag via
  // `registerGated`. This resolver accepts v2- AND v3-vault pools by identity
  // (a real v3 pool has no `getPoolId()` and never reaches here — see the
  // resolver's own comment); the mobile `BalancerLpAdapter` additionally
  // refuses to BUILD for anything but the pinned v2 Vault, so a v3 target
  // (if one ever slipped through) fails closed on-device rather than badging
  // "Deposit in-app" for a call nothing can make. v3 Router-based join/exit is
  // separate, larger work — not attempted here.
  registerGated("tier3", TIER3_BALANCER_RESOLVERS);

  // ── The protocol catalogue (protocols.ts) ────────────────────────────────
  // One entry per protocol, gating derived from the entry. Registered last so
  // a manifest never shadows a bespoke resolver that claims the same slug —
  // the registry tries claimants in order, and the hand-written one wins.
  //
  // A manifest's own API source registers here too, which is why it lands
  // AFTER the on-chain sources (chain state outranks an endpoint) and BEFORE
  // `/poolsOld` in practice: sources are consulted in registration order.
  bootProtocolManifests();

  // ── Tier 4 — ERC-7540 async vaults. ──────────────────────────────────────
  // §7's condition for registering an `async-vault` resolver ("the two-phase
  // request/claim interface ships") is now met: `StrategyPosition.asyncPhase`
  // is persisted at request time, `async-claim-watcher.processor.ts` polls
  // and notifies, and `defi_claim` (mobile) has a wired path to actually
  // claim once a position is claimable. Centrifuge is the first protocol —
  // discovered via its own GraphQL API, validated the same way every other
  // EVM kind is (§8.1: no `default: true`).
  registerGated("tier4", TIER4_CENTRIFUGE_RESOLVERS);

  // Convex / Aura (§6.3) are STILL withheld, and for a different reason than
  // async vaults were: boosting is a two-leg flow (acquire the Curve/Balancer
  // LP, then stake it) that `UnsignedCall`'s one-shot model cannot express at
  // all, request/claim or otherwise. §8.1 assigns them no validator. This is
  // not "the same machinery, not shipped yet" — it needs a genuinely
  // different multi-call primitive that async-vault's landing does not
  // provide.

  booted = true;
}

/** Test seam — lets a spec re-run bootstrap with different flags. */
export function resetTargetResolverBootstrap(): void {
  booted = false;
}
