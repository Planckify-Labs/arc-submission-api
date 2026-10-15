/**
 * `BridgeRouteAdapter` registry.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * Mirrors `services/defi/registry.ts` in the mobile repo exactly:
 * register / get / list, and NO central switch. `supports()` is the whole
 * seam — adding Bitcoin, or a non-LI.FI provider (a direct CCTP adapter, a
 * Stellar bridge when one exists), is REGISTERING AN ADAPTER. No enum
 * edit, no branch in shared code.
 *
 * The CAIP-2 ↔ provider-chain-id mapping (`eip155:8453` → `8453`,
 * `solana:…` → `1151111081099710`, `sui:mainnet` → `9270000000000000`)
 * lives INSIDE each adapter. That table is the provider's private
 * numbering and must never leak upward.
 */

import type {
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRef,
  BridgeStatus,
  BridgeSupportedChain,
  BridgeToken,
  Caip19,
  Caip2,
  GasTopUpRequest,
  RouteKind,
  RouteOption,
} from "./types";
import { routeKindOf } from "./types";

export interface RouteAdapter {
  /** Stable registry key, e.g. `"lifi"`, `"cctp"`, `"tower"`. */
  key: string;

  /** Topologies this adapter serves. Presence-checked, never branched on. */
  kinds: readonly RouteKind[];

  /** Can this adapter move value from `from` to `to` at all? */
  supports(from: Caip2, to: Caip2): boolean;

  /**
   * Narrower check for a specific asset pair. Optional: an adapter that
   * routes arbitrary tokens (LI.FI) can leave it undefined and let
   * `supports()` decide. A single-asset adapter (CCTP is USDC-only)
   * implements it so `USDC → Stellar` resolves while `ETH → Stellar`
   * correctly reports a capability boundary rather than a failure (§7.6).
   */
  supportsAsset?(from: Caip19, to: Caip19): boolean;

  /** Provider's private chain id. `null` when the chain is unknown to it. */
  toProviderChainId?(c: Caip2): string | number | null;

  /** Provider's private asset identifier. `null` when inexpressible. */
  toProviderAsset?(a: Caip19): string | null;

  quote(req: BridgeQuoteRequest): Promise<BridgeQuote>;

  status(ref: BridgeRef): Promise<BridgeStatus>;

  /** Chains this adapter currently reaches, for the queried matrix (§5.3). */
  listSupportedChains(): Promise<BridgeSupportedChain[]>;

  /** Bridge tool keys the adapter aggregates. `[]` for single-mechanism adapters. */
  listTools(): Promise<string[]>;

  /**
   * Resolve a CAIP-19 to full token metadata (symbol, DECIMALS, price).
   * Decimals must come from here, never a shared constant — Stellar USDC
   * is 7 decimals and every other CCTP chain is 6 (§5.4.1, §6).
   */
  resolveToken(asset: Caip19): Promise<BridgeToken | null>;

  // ── optional capabilities, presence-checked (space docking) ─────────
  /**
   * Route a small slice into the destination's gas token (§7.5, §5.2).
   * An adapter that cannot do this simply omits the method; callers
   * presence-check rather than branching. An adapter whose routes carry
   * no strand risk at all (Circle's Forwarding Service pays the
   * destination leg, §7.5.1) also omits it, which is the correct signal.
   */
  gasTopUp?(req: GasTopUpRequest): Promise<BridgeQuote>;

  /** Alternative venues for the same pair, for a venue picker (§6.3). */
  listRouteOptions?(req: BridgeQuoteRequest): Promise<RouteOption[]>;

  /** Contracts this provider may legitimately return. Absent = fail closed. */
  targetAllowlist?(chain: Caip2): Promise<readonly string[]>;

  /** Provider-side simulation, when it beats ours. */
  simulate?(q: BridgeQuote): Promise<unknown>;

  /** Provider-side calldata decoding, for §8.4 L4. */
  decodeCall?(q: BridgeQuote): Promise<unknown>;

  /** Serving stale cached data, so callers never claim freshness. */
  isDegraded?(): boolean;

  /**
   * Find a token on a chain by symbol, name or address, from the provider's
   * own token list. Optional and presence-checked: it is how a token pair
   * becomes routable with no row of ours (swap spec §4.6, "a new token
   * pair: nothing"). Identity trust is applied by the caller, never here.
   */
  searchTokens?(chain: Caip2, query: string): Promise<BridgeToken[]>;

  /**
   * The provider's token list for one chain, for a picker. Optional and
   * presence-checked like `searchTokens`; identity trust is applied by the
   * caller. An adapter with no enumerable list (on-chain reads only) omits
   * it and still serves exact lookups through `resolveToken`.
   */
  listTokens?(chain: Caip2): Promise<BridgeToken[]>;

  /**
   * The exact token pairs this provider can bridge from `from` to `to`
   * (same asset on both sides), for a validated picker. Optional and
   * presence-checked. An adapter that answers it must only list pairs it
   * would actually quote; the quote stays the final word on amounts.
   */
  listRoutablePairs?(
    from: Caip2,
    to: Caip2,
  ): Promise<Array<{ from: BridgeToken; to: BridgeToken }>>;

  /**
   * Tokens this provider can trade on `chain` (same-chain swaps), for a
   * validated picker. Optional and presence-checked.
   */
  listSwapTokens?(chain: Caip2): Promise<BridgeToken[]>;

}

export type BridgeRouteAdapter = RouteAdapter;

const adapters = new Map<string, RouteAdapter>();

export function registerBridgeAdapter(a: RouteAdapter): void {
  adapters.set(a.key, a);
}

export const registerRouteAdapter = registerBridgeAdapter;

export function getBridgeAdapter(key: string): RouteAdapter | null {
  return adapters.get(key) ?? null;
}

export const getRouteAdapter = getBridgeAdapter;

export function listBridgeAdapters(): RouteAdapter[] {
  return [...adapters.values()];
}

export const listRouteAdapters = listBridgeAdapters;

/** Test-only: drop every registration so suites start from a clean slate. */
export function resetBridgeAdapters(): void {
  adapters.clear();
}

export const resetRouteAdapters = resetBridgeAdapters;

/**
 * Every adapter that can serve this exact route, most-specific first.
 *
 * Filter by kinds including the requested topology (§4.3).
 * An adapter that declares `supportsAsset` is answering a narrower
 * question, so it sorts ahead of one that only answered `supports`.
 */
export function resolveBridgeAdapters(
  from: Caip2,
  to: Caip2,
  fromAsset?: Caip19,
  toAsset?: Caip19,
  kind?: RouteKind,
): RouteAdapter[] {
  const targetKind = kind ?? routeKindOf(from, to);
  const eligible = listBridgeAdapters().filter((a) => {
    if (a.kinds && !a.kinds.includes(targetKind)) return false;
    if (!a.supports(from, to)) return false;
    if (a.supportsAsset && fromAsset && toAsset) {
      return a.supportsAsset(fromAsset, toAsset);
    }
    return true;
  });
  return eligible.sort((a, b) => {
    const aSpecific = a.supportsAsset ? 1 : 0;
    const bSpecific = b.supportsAsset ? 1 : 0;
    return bSpecific - aSpecific;
  });
}

export const resolveRouteAdapters = resolveBridgeAdapters;
