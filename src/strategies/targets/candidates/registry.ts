/**
 * Candidate-address sources — how a resolver gets "the contract this pool is
 * probably about" (spec §4, §12 Q1).
 *
 * A DeFiLlama `/pools` id is an opaque UUID, so turning a pool row into an
 * on-chain address needs a *candidate* from somewhere, which the resolver's
 * validator then proves or rejects. For a long time there was exactly one
 * somewhere: DeFiLlama's `/poolsOld` feed. Then DeFiLlama put it behind a paid
 * plan and **seven resolver families stopped resolving anything**, with no
 * error, because a missing candidate is indistinguishable from "this pool is
 * not ours".
 *
 * One external endpoint should never have been able to do that. So candidates
 * now come from a registry of sources, tried in order:
 *
 *   1. **Protocol-specific sources** — the protocol's OWN on-chain registry
 *      (Euler's `GenericFactory` proxy list, Fluid's `getAllFTokens`, Curve's
 *      MetaRegistry, a Solidly factory's `getPool`). These are strictly better
 *      than an aggregator: nobody can paywall them, they cannot go stale, and
 *      reading them is the same trust model as the validator that follows.
 *   2. **The generic fallback** — `/poolsOld`, when it is reachable.
 *
 * Adding a protocol is one `registerCandidateSource(...)`. No branch anywhere,
 * same docking rule as the resolver registry itself.
 *
 * A candidate is never an authority. Every caller still runs its kind's
 * validator, and a wrong candidate fails closed to Manual rather than routing
 * funds (§8.2). What a source must never do is *invent* an address: returning
 * null is always correct, guessing never is.
 */

import type { DeFiLlamaYieldPool } from "../../external/defillama.client";
import type { Address, ResolverContext } from "../types";

export interface CandidateSource {
  /** Stable id, for logs and for de-registration in tests. */
  readonly id: string;
  /**
   * DeFiLlama `project` slugs this source can serve, or `"*"` for the generic
   * fallback that is tried after every specific source has declined.
   */
  readonly projects: readonly string[] | "*";
  /**
   * The address this pool is about, or null. MUST NOT throw — a source that
   * blows up is treated as "no candidate", never as a failed resolve.
   */
  candidate(
    pool: DeFiLlamaYieldPool,
    ctx: ResolverContext,
  ): Promise<Address | null>;
  /**
   * Also asked to CHECK an answer another source gave (see
   * `independentSourcesAgree`). Only for a source whose address means the same
   * contract the asking resolver means — a vault-keyed source cannot judge a
   * Curve pool whose catalog key is the LP token.
   */
  readonly corroborates?: boolean;
}

/** A candidate and the source that produced it. */
export interface CandidateAnswer {
  address: Address;
  sourceId: string;
}

const byProject = new Map<string, CandidateSource[]>();
const fallbacks: CandidateSource[] = [];

function norm(project: string | undefined): string {
  return (project ?? "").trim().toLowerCase();
}

export function registerCandidateSource(source: CandidateSource): void {
  if (source.projects === "*") {
    if (!fallbacks.some((s) => s.id === source.id)) fallbacks.push(source);
    return;
  }
  for (const project of source.projects) {
    const key = norm(project);
    if (!key) continue;
    const list = byProject.get(key) ?? [];
    if (!list.some((s) => s.id === source.id)) list.push(source);
    byProject.set(key, list);
  }
}

/** Test seam — drops every registration. */
export function resetCandidateSources(): void {
  byProject.clear();
  fallbacks.length = 0;
  sourceHealth.clear();
}

/** Which sources would be consulted for a project, in order. */
export function sourcesForProject(
  project: string | undefined,
): readonly CandidateSource[] {
  return [...(byProject.get(norm(project)) ?? []), ...fallbacks];
}

/**
 * Best-effort candidate contract address for a pool.
 *
 * Tries each source in order and takes the first non-null answer. A source that
 * throws is skipped, not propagated: one protocol's API being down must not
 * turn into a resolver failure for a pool that another source could have
 * answered.
 */
export async function candidateAddressForPool(
  pool: DeFiLlamaYieldPool,
  ctx: ResolverContext,
): Promise<Address | null> {
  return (await candidateForPool(pool, ctx))?.address ?? null;
}

/** `candidateAddressForPool`, also saying which source answered. */
export async function candidateForPool(
  pool: DeFiLlamaYieldPool,
  ctx: ResolverContext,
): Promise<CandidateAnswer | null> {
  for (const source of sourcesForProject(pool.project)) {
    try {
      const address = await source.candidate(pool, ctx);
      recordSourceOutcome(source.id, address ? "hit" : "miss");
      if (address) return { address, sourceId: source.id };
    } catch {
      // Treated as "this source has no answer". Deliberately silent per-pool:
      // the sources log their own systemic failures once (see poolsOld).
      recordSourceOutcome(source.id, "error");
    }
  }
  return null;
}

/**
 * Two independent sources must not name different contracts for one pool.
 *
 * The first source to answer wins the lookup, so a wrong answer from it used
 * to be checked only by the validator — and a sibling vault of the same asset
 * passes the validator. Every source marked `corroborates`, other than the one
 * that answered, is asked too; a source with no answer abstains, a DIFFERENT
 * answer is a refusal (the pool stays Manual) and is logged, because one of
 * two sources we trust is wrong about where the money goes.
 */
export async function independentSourcesAgree(
  pool: DeFiLlamaYieldPool,
  ctx: ResolverContext,
  answer: CandidateAnswer,
): Promise<boolean> {
  for (const source of sourcesForProject(pool.project)) {
    if (!source.corroborates || source.id === answer.sourceId) continue;
    const other = await source.candidate(pool, ctx).catch(() => null);
    if (other && other.toLowerCase() !== answer.address.toLowerCase()) {
      console.warn(
        `[candidates] ${pool.project} pool ${pool.pool}: ${answer.sourceId} says ${answer.address}, ` +
          `${source.id} says ${other}. Refusing the pool until they agree.`,
      );
      return false;
    }
  }
  return true;
}

// ── Discovery health (§11.5b) ───────────────────────────────────────────────
//
// `/poolsOld` went to HTTP 402 and took every discovery-dependent family with
// it. Nothing broke loudly: a source that answers nothing is indistinguishable
// from a source whose pools simply are not ours, so seven families degraded to
// Manual and stayed there. The cost of that silence was measured in days.
//
// This is the cheap fix. Every dispatch records an outcome per source, and a
// source that has been asked enough times to have an opinion and has never
// answered is reported as DARK — once, so it is a signal rather than noise.
// It cannot decide anything (a wrong candidate still fails Layer-1); it exists
// so "this family went quiet" is something we notice instead of discover.

interface SourceHealth {
  hits: number;
  misses: number;
  errors: number;
  /** Latched so the warning is emitted once per process, not per pool. */
  warned: boolean;
}

/** Asks before a never-answering source is worth reporting. Below this, "no
 *  answer" is more likely "no pools of ours" than a broken source. */
const DARK_SOURCE_MIN_ATTEMPTS = 25;

const sourceHealth = new Map<string, SourceHealth>();

function recordSourceOutcome(
  id: string,
  outcome: "hit" | "miss" | "error",
): void {
  const h = sourceHealth.get(id) ?? {
    hits: 0,
    misses: 0,
    errors: 0,
    warned: false,
  };
  if (outcome === "hit") h.hits++;
  else if (outcome === "miss") h.misses++;
  else h.errors++;
  sourceHealth.set(id, h);

  if (h.warned || h.hits > 0) return;
  const attempts = h.misses + h.errors;
  if (attempts < DARK_SOURCE_MIN_ATTEMPTS) return;
  h.warned = true;
  console.warn(
    `[candidates] source "${id}" is DARK: ${attempts} lookups, 0 addresses ` +
      `(${h.errors} threw). Every family relying on it resolves to Manual. ` +
      `Check the endpoint before assuming those protocols simply have no pools.`,
  );
}

export interface CandidateSourceHealth {
  readonly id: string;
  readonly hits: number;
  readonly misses: number;
  readonly errors: number;
  /** Asked enough to have an opinion, and never answered. */
  readonly dark: boolean;
}

/** Snapshot for the dry run and for ops diagnostics. Never used for matching. */
export function candidateSourceHealth(): readonly CandidateSourceHealth[] {
  return [...sourceHealth.entries()].map(([id, h]) => ({
    id,
    hits: h.hits,
    misses: h.misses,
    errors: h.errors,
    dark: h.hits === 0 && h.misses + h.errors >= DARK_SOURCE_MIN_ATTEMPTS,
  }));
}

/** Test seam. */
export function resetCandidateSourceHealth(): void {
  sourceHealth.clear();
}

/**
 * Shared matching rule for sources that enumerate a protocol's vaults.
 *
 * Filter by the deposited asset, then disambiguate by label — and require the
 * label to select EXACTLY ONE vault. Several hits is ambiguity, and ambiguity
 * is a refusal: picking the first would be a guess about where a user's money
 * goes. When there is nothing to disambiguate with, a single remaining
 * candidate is still unambiguous and is allowed.
 */
export function pickUniqueByLabel<T>(
  candidates: readonly T[],
  labels: readonly (string | null | undefined)[],
  labelsOf: (candidate: T) => (string | null | undefined)[],
): T | null {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const label of labels) {
    const needle = norm(label);
    if (!needle) continue;
    const hits = candidates.filter((c) =>
      labelsOf(c).some((l) => {
        const hay = norm(l);
        return hay.length > 0 && (hay.includes(needle) || needle.includes(hay));
      }),
    );
    if (hits.length === 1) return hits[0];
  }
  return candidates.length === 1 ? candidates[0] : null;
}
