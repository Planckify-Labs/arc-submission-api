/**
 * ERC-4626 resolvers — Morpho MetaMorpho + Yearn v3 (spec §3.1, §5, §7.1).
 *
 * The whole ERC-4626 family (Morpho/Yearn/Euler/Gearbox…) maps to ONE mobile
 * adapter (`Erc4626Adapter`); a resolver's only job is to turn the DeFiLlama
 * pool's matching keys — `(underlyingTokens[0], poolMeta, chain)` — into the
 * concrete `{ kind: "erc4626", vault, asset }`. We match against the
 * protocol's own free HTTPS registry (Morpho blue-api / Yearn yDaemon), never
 * an SDK (spec §3.1 "prefer the plain HTTPS endpoint over the SDK").
 *
 * Fail closed: no confident match → `null` → the pool stays "manual".
 */

import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { warnOnce } from "./candidates/protocol-api.source";
import { candidateAddressForPool } from "./candidates/registry";
import type {
  Address,
  DepositTarget,
  PoolTargetResolver,
  ResolverContext,
} from "./types";
import { eqAddr, resolveEvmChainId, underlyingOf } from "./types";

const VAULT_LIST_TTL_SEC = 30 * 60; // matches the poll cadence

/** Normalise a vault/market label for fuzzy name matching (poolMeta ↔ name). */
function normLabel(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function labelMatches(
  poolMeta: string,
  ...candidates: (string | null | undefined)[]
): boolean {
  const needle = normLabel(poolMeta);
  if (!needle) return false;
  return candidates.some((c) => {
    const hay = normLabel(c);
    return hay.length > 0 && (hay.includes(needle) || needle.includes(hay));
  });
}

/**
 * Pick the one vault a pool names, or nothing.
 *
 * Two label sources, because DeFiLlama is inconsistent about where the vault
 * identity lives: for some protocols it is `poolMeta` ("Steakhouse USDC"), and
 * for Morpho it is `symbol` ("STEAKUSDC") with `poolMeta` null. Reading only
 * `poolMeta` meant every Morpho pool on Base fell into the ambiguous branch —
 * dozens of MetaMorpho vaults share USDC as their asset — and refused.
 *
 * The rules that keep this from becoming a guess:
 *   - a label must select EXACTLY ONE candidate; several hits is ambiguity, and
 *     ambiguity is a refusal, never "take the first one",
 *   - an explicit `poolMeta` that matches nothing is a mismatch signal, so we
 *     refuse rather than falling back to a lone candidate,
 *   - whatever is picked still has to pass `validateErc4626` on-chain, so a
 *     wrong label match cannot survive: the vault would report a different
 *     `asset()` and be rejected.
 */
function pickLabelledCandidate<T>(
  candidates: readonly T[],
  labels: readonly (string | null | undefined)[],
  labelsOf: (candidate: T) => (string | null | undefined)[],
): T | null {
  const [primary, ...rest] = labels;

  if (primary) {
    const hits = candidates.filter((c) =>
      labelMatches(primary, ...labelsOf(c)),
    );
    // An explicit primary label is a claim about identity: honour it or refuse.
    return hits.length === 1 ? hits[0] : null;
  }

  for (const label of rest) {
    if (!label) continue;
    const hits = candidates.filter((c) => labelMatches(label, ...labelsOf(c)));
    if (hits.length === 1) return hits[0];
  }

  // Nothing to disambiguate with, but only one thing it could be.
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Disambiguate by ADDRESS when the labels cannot.
 *
 * Yearn is the case that forced this: DeFiLlama's yearn rows carry
 * `poolMeta: null` and `symbol` = the *asset* ("USDC"), and mainnet has four
 * distinct USDC vaults. There is nothing in the pool row to tell them apart, so
 * `pickLabelledCandidate` correctly refused all thirteen — correct, and also
 * permanently zero coverage.
 *
 * The candidate registry does have an answer (the protocol's own deep link
 * names the vault), so it is consulted as a tie-break. The important property
 * is the direction: the candidate may only **select** from vaults the
 * protocol's own registry already lists for this asset, never introduce one.
 * An address that the registry does not list is discarded, so a bad candidate
 * degrades to Manual instead of steering the match.
 */
/**
 * What the protocol's own deep link says this pool is, as a THREE-state answer.
 *
 * `"unvouched"` is the state that matters and the one a plain `T | null` cannot
 * express. Returning null for "an address was named, but it is not in our
 * candidate set" let the caller fall through to label matching — and label
 * matching then produced a confident, wrong answer.
 *
 * Measured 2026-08-21: **25 of 69 resolving Morpho pools, ~$478M, deposited
 * into a different vault than their row describes.** Ethereum `STEAKUSDC` is
 * the clean example — the row is $92.0M, DeFiLlama's link names a vault holding
 * $93.9M ("Steakhouse Prime USDC"), and the label matcher instead picked a
 * $75.0M vault called "Steakhouse USDC". Same brand, same asset, same symbol,
 * different product and different APY.
 *
 * Nothing downstream objected: `validateErc4626` checks `asset()` (both USDC)
 * and a TVL band wide enough to swallow an 18% gap. This is the
 * `spark-savings -> SparkLend` failure one level down.
 *
 * So an address, when the protocol supplies one, is treated the same way §4's
 * comment already treats an explicit `poolMeta`: **a claim about identity —
 * honour it or refuse.** It is the strongest signal available and it must not
 * be overridden by a fuzzy symbol match. The direction stays fail-closed: the
 * link may only SELECT from vaults the protocol's own registry already lists
 * (§11.5b), never introduce one, so the worst case is Manual.
 */
type AddressClaim<T> =
  /** The link named an address, and the registry lists it. */
  | { kind: "match"; candidate: T }
  /**
   * The link named an address the registry does NOT list — commonly a Morpho
   * Vault V2, which lives behind a different GraphQL type (§11.6b). We cannot
   * vouch for it, and the pool is definitively not about any candidate we do
   * have, so labels must not get a second opinion.
   */
  | { kind: "unvouched" }
  /** No address available. Labels are the only signal left. */
  | { kind: "none" };

async function claimByCandidateAddress<T>(
  candidates: readonly T[],
  pool: DeFiLlamaYieldPool,
  ctx: ResolverContext,
  addressOf: (candidate: T) => string | null | undefined,
): Promise<AddressClaim<T>> {
  if (candidates.length === 0) return { kind: "none" };
  const address = await candidateAddressForPool(pool, ctx);
  if (!address) return { kind: "none" };
  const hits = candidates.filter((c) => eqAddr(addressOf(c), address));
  // Several candidates on one address should be impossible; if a registry ever
  // does that, it is ambiguity, and ambiguity is a refusal.
  if (hits.length === 1) return { kind: "match", candidate: hits[0] };
  return { kind: "unvouched" };
}

/**
 * A bespoke resolver fetches its own registry, which means the discovery-health
 * check in `candidates/registry.ts` cannot see it: those counters only track
 * registered `CandidateSource`s. So when one of these endpoints goes quiet the
 * family reads as "no pools of ours" with nothing anywhere saying otherwise.
 *
 * That is not hypothetical. `ydaemon.yearn.fi` publishes a NAT64 AAAA record
 * that Node's happy-eyeballs fails against while curl succeeds, so the fetch
 * threw, the catch returned `[]`, and Yearn resolved 0/13 with no signal at
 * all — the /poolsOld outage in miniature, one file over.
 *
 * An empty registry is always worth one line. It is either a real outage or a
 * protocol with no vaults, and those two need very different responses.
 */
function warnEmptyRegistry(
  family: string,
  chainId: number,
  host: string,
): void {
  warnOnce(
    `${family}:empty:${chainId}`,
    `[${family}] ${host} returned no vaults for chain ${chainId}. Every ${family} ` +
      `pool on this chain will resolve to Manual. Check the endpoint before ` +
      `assuming the protocol has no vaults here.`,
  );
}

// ── Morpho MetaMorpho (api.morpho.org/graphql) ──────────────────────────────

interface MorphoVault {
  address: string;
  name: string | null;
  symbol: string | null;
  listed?: boolean;
  asset: { address: string } | null;
}

/**
 * Morpho renamed `whitelisted` → `listed` on `Vault` (and the same rename plus
 * `uniqueKey` → `marketId` on `Market`). A rejected GraphQL query is HTTP 200
 * with `errors` and no `data`, so the old field name did not throw — it
 * returned zero vaults, and every MetaMorpho pool degraded to Manual with no
 * error anywhere. `external-api-drift.spec.ts` now fails on the next rename.
 */
const MORPHO_QUERY = `query Vaults($chainId: Int!) {
  vaults(first: 1000, where: { chainId_in: [$chainId] }) {
    items { address name symbol listed asset { address } }
  }
  vaultV2s(first: 1000, where: { chainId_in: [$chainId] }) {
    items { address name symbol listed asset { address } }
  }
}`;

/** Exported so the drift spec asserts the EXACT query this resolver sends. */
export const MORPHO_VAULTS_QUERY = MORPHO_QUERY;

async function fetchMorphoVaults(
  chainId: number,
  ctx: ResolverContext,
): Promise<MorphoVault[]> {
  const res = await ctx.fetchJsonCached<{
    data?: {
      vaults?: { items?: MorphoVault[] };
      vaultV2s?: { items?: MorphoVault[] };
    };
    errors?: Array<{ message?: string }>;
  }>(
    // v3: the body now carries Vault V2s too, so a cached v2 body (V1 only)
    // would hide every V2 vault for the whole TTL.
    `defillama:targets:morpho:vaults:${chainId}:v3`,
    "https://api.morpho.org/graphql",
    VAULT_LIST_TTL_SEC,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: MORPHO_QUERY, variables: { chainId } }),
    },
  );
  if (res?.errors?.length) {
    console.warn(
      `[morpho] vaults query rejected by api.morpho.org (schema drift?): ${res.errors
        .map((e) => e.message ?? "unknown")
        .join("; ")}`,
    );
    return [];
  }
  // Vault V2 is Morpho's current vault (the only kind on Arc, 2026-10-26),
  // ERC-4626 with a gate convention validateErc4626 understands. A V2 vault
  // must be LISTED by Morpho itself: the registry also returns anyone's
  // deployments, including a no-curator copy named after a real vault, and
  // the protocol's own listing is the curation fact we can check.
  const v2 = (res?.data?.vaultV2s?.items ?? []).filter(
    (v) => v.listed === true,
  );
  const items = [...(res?.data?.vaults?.items ?? []), ...v2];
  if (items.length === 0)
    warnEmptyRegistry("morpho", chainId, "api.morpho.org");
  return items;
}

export const MorphoResolver: PoolTargetResolver = {
  family: "morpho",
  aliases: [
    "morpho-blue",
    "morpho-aave-v3",
    "morpho-aavev2",
    "morpho",
    "morpho-vault",
  ],
  async resolve(pool, ctx): Promise<DepositTarget | null> {
    const chainId = resolveEvmChainId(pool.chain);
    if (!chainId) return null;
    const underlying = underlyingOf(pool);
    if (!underlying) return null;

    const vaults = await fetchMorphoVaults(chainId, ctx);
    const candidates = vaults.filter(
      (v) =>
        v.address &&
        v.asset?.address &&
        eqAddr(v.asset.address, underlying) &&
        v.listed !== false,
    );
    if (candidates.length === 0) return null;

    // Morpho pools carry the vault identity in `symbol` (STEAKUSDC) with
    // `poolMeta` null, so `symbol` is the fallback label here.
    const claim = await claimByCandidateAddress(
      candidates,
      pool,
      ctx,
      (v) => v.address,
    );
    // Morpho's link names the vault outright. When it does, it decides.
    if (claim.kind === "unvouched") return null;
    const match =
      claim.kind === "match"
        ? claim.candidate
        : pickLabelledCandidate(
            candidates,
            [pool.poolMeta, pool.symbol],
            (v) => [v.name, v.symbol],
          );
    if (!match) return null;

    const target: DepositTarget = {
      kind: "erc4626",
      vault: match.address.toLowerCase() as Address,
      asset: (match.asset?.address ?? underlying).toLowerCase() as Address,
    };
    return (await ctx.validate(target, pool)) ? target : null;
  },
};

// ── Yearn v3 (ydaemon.yearn.fi/{chainId}/vaults/all) ────────────────────────

interface YearnVault {
  address: string;
  name?: string;
  symbol?: string;
  kind?: string;
  version?: string;
  token?: { address?: string };
}

async function fetchYearnVaults(
  chainId: number,
  ctx: ResolverContext,
): Promise<YearnVault[]> {
  const res = await ctx.fetchJsonCached<YearnVault[]>(
    `defillama:targets:yearn:vaults:${chainId}:v1`,
    `https://ydaemon.yearn.fi/${chainId}/vaults/all`,
    VAULT_LIST_TTL_SEC,
  );
  const items = Array.isArray(res) ? res : [];
  if (items.length === 0)
    warnEmptyRegistry("yearn", chainId, "ydaemon.yearn.fi");
  return items;
}

export const YearnResolver: PoolTargetResolver = {
  family: "yearn",
  aliases: ["yearn-finance", "yearn-v3", "yearn", "yearn-v2"],
  async resolve(pool, ctx): Promise<DepositTarget | null> {
    const chainId = resolveEvmChainId(pool.chain);
    if (!chainId) return null;
    const underlying = underlyingOf(pool);
    if (!underlying) return null;

    const vaults = await fetchYearnVaults(chainId, ctx);
    // Prefer v3 (ERC-4626 compliant); v2 vaults are also 4626-shaped enough
    // for deposit(assets, receiver) but validation will confirm.
    const candidates = vaults.filter(
      (v) => v.address && eqAddr(v.token?.address, underlying),
    );
    if (candidates.length === 0) return null;

    // Yearn gets the same treatment as Morpho, and needs it more: its rows
    // carry `poolMeta: null` and `symbol` = the ASSET ("USDC"), while mainnet
    // has four distinct USDC vaults. The label is nearly worthless here, so
    // letting it override the address the protocol itself names would be the
    // Morpho mis-route with a weaker signal doing the overriding.
    //
    // Not separately measured — DeFiLlama was rate-limiting when this shipped.
    // Applying it is still the safe direction: an exclusive address claim can
    // only move a pool to Manual, never onto a different vault.
    const claim = await claimByCandidateAddress(
      candidates,
      pool,
      ctx,
      (v) => v.address,
    );
    if (claim.kind === "unvouched") return null;
    const match =
      claim.kind === "match"
        ? claim.candidate
        : pickLabelledCandidate(
            candidates,
            [pool.poolMeta, pool.symbol],
            (v) => [v.name, v.symbol],
          );
    if (!match) return null;

    const target: DepositTarget = {
      kind: "erc4626",
      vault: match.address.toLowerCase() as Address,
      asset: underlying as Address,
    };
    return (await ctx.validate(target, pool)) ? target : null;
  },
};
