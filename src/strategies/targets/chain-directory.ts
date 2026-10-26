/**
 * Chain directory — the DATA-DRIVEN answer to "which chains do we support, and
 * how do we reach them".
 *
 * Chain support is **never hardcoded**. The `Blockchain` table is the source of
 * truth (the same rows `GET /blockchains` serves the app), so onboarding an EVM
 * chain for DeFi is a seeded row plus an rpc-proxy route — not a code change,
 * not a redeploy, and not an edit to any resolver. This mirrors how the rest of
 * the product treats chains: `Blockchain.type` is a plain string precisely so a
 * new chain in an existing family needs no migration
 * (`src/blockchains/chain-family.ts`).
 *
 * The directory is a snapshot loaded at boot and refreshed on a TTL by
 * `TargetResolverService`, which keeps `resolveEvmChainId` a **synchronous**
 * lookup — every resolver and `validation.ts` call it inline, and threading an
 * async DB read through those pure functions would push chain knowledge back
 * into each of them.
 *
 * Fail-closed: an unloaded or unknown chain resolves to `0`, so the resolver
 * returns `null` and the pool degrades to the Manual deep-link path. A chain we
 * cannot reach is never a chain we route funds on.
 */

import type { Chain } from "viem";

/** One row of the directory, projected from `Blockchain`. */
export interface ChainDirectoryRow {
  /** EVM chain id. Null for non-EVM families (they key on `chainSlug`). */
  chainId: number | null;
  name: string;
  chainSlug: string | null;
  /** Raw `Blockchain.rpcUrl` — an rpc-proxy route ("/evm/1") or absolute URL. */
  rpcUrl: string;
  /** `Blockchain.type` — "EVM" | "SVM" | "MOVE_VM" | "STELLAR". */
  family: string;
  isTestnet: boolean;
  /** Native coin metadata, when the chain's native token row is known. */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  /**
   * Symbols of the chain's active `Token` rows — the assets the app lists on
   * this chain. The yield ingester admits pools for them, so a chain's own
   * assets (Monad's AUSD/MON, Stellar's XLM) need a token row, not a code edit.
   */
  assetSymbols?: string[];
}

/**
 * Chain-family → wallet namespace. The families themselves are validated by
 * `assertChainFamily`; this is the projection DeFi opportunities are keyed by
 * (`OpportunityCache.namespace`).
 */
const FAMILY_NAMESPACE: Record<string, string> = {
  EVM: "eip155",
  SVM: "solana",
  MOVE_VM: "sui",
  STELLAR: "stellar",
};

let rows: ChainDirectoryRow[] = [];
/** Normalised external name → row. Rebuilt whenever the snapshot is replaced. */
let byName = new Map<string, ChainDirectoryRow>();
let byChainId = new Map<number, ChainDirectoryRow>();

/** Lowercase + strip everything but a–z0–9 so "BNB Smart Chain" == "bnbsmartchain". */
function norm(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Ops-configurable aliases for external catalog names that don't match any
 * `Blockchain.name` / `chainSlug` — e.g. DeFiLlama says "BSC" where the row is
 * named "BNB Smart Chain". JSON in `STRATEGIES_CHAIN_ALIASES`, mapping the
 * external name to a chain id or a `chainSlug`:
 *
 *   STRATEGIES_CHAIN_ALIASES='{"bsc":56,"op mainnet":"optimism"}'
 *
 * Env rather than code so adding one is a config change, consistent with the
 * "chains are data" rule. Malformed JSON is ignored (and logged by the caller
 * via `chainDirectoryDiagnostics`), never fatal.
 */
function parseAliases(): Record<string, number | string> {
  const raw = process.env.STRATEGIES_CHAIN_ALIASES?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "number" || typeof value === "string") {
        out[norm(key)] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

let aliasesCache: Record<string, number | string> | null = null;
let aliasesRaw: string | undefined;

function aliases(): Record<string, number | string> {
  const raw = process.env.STRATEGIES_CHAIN_ALIASES;
  if (aliasesCache === null || raw !== aliasesRaw) {
    aliasesRaw = raw;
    aliasesCache = parseAliases();
  }
  return aliasesCache;
}

/**
 * Replace the directory snapshot. Called by `TargetResolverService` with the
 * active `Blockchain` rows; also the seam unit tests load fixtures through.
 */
export function loadChainDirectory(next: readonly ChainDirectoryRow[]): void {
  rows = [...next];
  byName = new Map();
  byChainId = new Map();
  for (const row of rows) {
    for (const key of [norm(row.name), norm(row.chainSlug)]) {
      // First writer wins so a testnet row named similarly to a mainnet one
      // can't shadow it; rows are loaded mainnet-first by the caller.
      if (key && !byName.has(key)) byName.set(key, row);
    }
    if (typeof row.chainId === "number" && !byChainId.has(row.chainId)) {
      byChainId.set(row.chainId, row);
    }
  }
}

export function chainDirectorySize(): number {
  return rows.length;
}

export function listChainDirectory(): ChainDirectoryRow[] {
  return [...rows];
}

/** Look up a row by an external catalog chain name (DeFiLlama `pool.chain`). */
export function findChainByName(
  chainName: string | undefined,
): ChainDirectoryRow | null {
  const key = norm(chainName);
  if (!key) return null;

  // Aliases are consulted BEFORE the name index, so an operator can correct a
  // wrong match and not merely fill a missing one. Seen in production: the
  // mainnet row is named "Base Mainnet" while the Sepolia row is named "Base",
  // so DeFiLlama's "Base" matched the testnet and every Base pool went dark.
  // With the index first, the alias was powerless against exactly the case it
  // exists for. Explicit operator intent outranks incidental row naming, and an
  // alias still only ever selects a chain — it can never become a `tx.to`.
  const alias = aliases()[key];
  if (typeof alias === "number") return byChainId.get(alias) ?? null;
  if (typeof alias === "string") return byName.get(norm(alias)) ?? null;

  return byName.get(key) ?? null;
}

export function findChainById(chainId: number): ChainDirectoryRow | null {
  return byChainId.get(chainId) ?? null;
}

/**
 * DeFiLlama chain name → EVM chainId, or `0` when the chain is not a supported
 * EVM chain (unknown, non-EVM, or the directory hasn't loaded). Callers treat
 * `0` as "cannot resolve" and fail closed to Manual.
 */
export function resolveEvmChainId(chainName: string | undefined): number {
  const row = findChainByName(chainName);
  if (!row || row.family !== "EVM") return 0;
  return typeof row.chainId === "number" ? row.chainId : 0;
}

/**
 * DeFiLlama chain name → `(namespace, chainId)` for `OpportunityCache`.
 * Unknown chains report `chainId: 0`, which the scorer already treats as
 * "no EVM deployment" — the same fail-closed default as before, now sourced
 * from the DB instead of a literal map.
 */
export function resolveChainIdentity(chainName: string | undefined): {
  namespace: string;
  chainId: number;
} | null {
  const row = findChainByName(chainName);
  if (!row) return null;
  const namespace = FAMILY_NAMESPACE[row.family];
  if (!namespace) return null;
  return {
    namespace,
    chainId: row.family === "EVM" ? (row.chainId ?? 0) : 0,
  };
}

/**
 * A viem `Chain` synthesised from the directory row — no bundled per-chain
 * constant, so any EVM chain ops seed is immediately usable for validation
 * reads. `nativeCurrency` is required by viem's type but unused by
 * `readContract`; it falls back to an 18-decimal placeholder named after the
 * chain when the row carries no native-token metadata.
 */
export function viemChainFromRow(row: ChainDirectoryRow, url: string): Chain {
  return {
    id: row.chainId as number,
    name: row.name,
    nativeCurrency: row.nativeCurrency ?? {
      name: row.name,
      symbol: row.chainSlug?.toUpperCase() ?? "NATIVE",
      decimals: 18,
    },
    rpcUrls: { default: { http: [url] } },
    testnet: row.isTestnet,
  };
}

/** Small diagnostic payload for boot logging. */
export function chainDirectoryDiagnostics(): {
  loaded: number;
  evm: number;
  aliasCount: number;
} {
  return {
    loaded: rows.length,
    evm: rows.filter((r) => r.family === "EVM").length,
    aliasCount: Object.keys(aliases()).length,
  };
}
