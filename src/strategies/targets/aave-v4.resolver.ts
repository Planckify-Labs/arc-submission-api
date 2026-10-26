/**
 * Aave v4 — hub pools deposited through Aave's own TokenizationSpokes.
 *
 * v4 is hub-and-spoke: liquidity lives in a hub, and users reach it through
 * spokes. A TokenizationSpoke is Aave's "ERC4626 compliant wrapper to
 * tokenize one listed asset of the connected Hub", so depositing into one is
 * supplying to that hub asset. That makes a v4 hub pool an ordinary
 * `erc4626` target, executed by the shipped ERC-4626 adapter and checked by
 * every ERC-4626 safety check, instead of a new v4 call shape.
 *
 * Identity, which is what this file is for:
 *   1. The spoke comes from Aave's book (`AAVE_V4_TOKENIZATION_SPOKES`),
 *      never from an aggregator.
 *   2. It must match the pool's asset AND its hub. DeFiLlama and the market
 *      API both label a v4 pool with its hub's name in `poolMeta`; the hub is
 *      matched even when only one spoke shares the asset, because the same
 *      asset on another hub is a different market at a different rate.
 *   3. On chain, the spoke's `hub()` and `asset()` must equal the book's.
 *
 * Why the TVL band is skipped here, and only here: a v4 pool's TVL is the
 * whole hub asset (Arc's Core USDC: ~$143M supplied), while the
 * TokenizationSpoke holds only what was deposited through it. The band would
 * refuse every v4 pool. Its job, binding the candidate to the pool on the
 * card, is done more strongly by (3). Exit cost, holder exit, cooldown and
 * deposit-gate checks all still run.
 *
 * This replaces the `reserved` claim on `aave-v4`, which existed because the
 * substring fallback once routed v4 pools onto the v3 Pool. Registering this
 * resolver claims the slug exactly, which keeps that door shut.
 */

import { parseAbi } from "viem";
import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import {
  AAVE_V4_TOKENIZATION_SPOKES,
  type AaveV4TokenizationSpoke,
} from "./address-book/vaults";
import type {
  Address,
  DepositTarget,
  PoolTargetResolver,
  ResolverContext,
} from "./types";
import { eqAddr, resolveEvmChainId, underlyingOf } from "./types";

const SPOKE_ABI = parseAbi([
  "function hub() view returns (address)",
  "function asset() view returns (address)",
]);

/** "GLOBAL_DOLLAR", "Global Dollar" and "globaldollar" are one hub name. */
function normHub(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The single book entry for this pool's (chain, asset, hub), or null. */
export function spokeForPool(
  pool: DeFiLlamaYieldPool,
  chainId: number,
  book: Readonly<
    Record<number, readonly AaveV4TokenizationSpoke[]>
  > = AAVE_V4_TOKENIZATION_SPOKES,
): AaveV4TokenizationSpoke | null {
  const underlying = underlyingOf(pool);
  const hub = normHub(pool.poolMeta);
  if (!underlying || !hub) return null;
  const matches = (book[chainId] ?? []).filter(
    (s) => eqAddr(s.asset, underlying) && normHub(s.hubName) === hub,
  );
  return matches.length === 1 ? matches[0] : null;
}

async function boundOnChain(
  spoke: AaveV4TokenizationSpoke,
  chainId: number,
  ctx: ResolverContext,
): Promise<boolean> {
  const client = ctx.publicClient?.(chainId);
  if (!client) return false;
  try {
    const [hub, asset] = await Promise.all([
      client.readContract({
        address: spoke.vault,
        abi: SPOKE_ABI,
        functionName: "hub",
      }),
      client.readContract({
        address: spoke.vault,
        abi: SPOKE_ABI,
        functionName: "asset",
      }),
    ]);
    return (
      eqAddr(hub as string, spoke.hub) && eqAddr(asset as string, spoke.asset)
    );
  } catch {
    return false;
  }
}

export const AaveV4Resolver: PoolTargetResolver = {
  family: "aave-v4",
  aliases: ["aave-v4", "aave-v4-core"],
  async resolve(pool, ctx): Promise<DepositTarget | null> {
    const chainId = resolveEvmChainId(pool.chain);
    if (!chainId) return null;
    const spoke = spokeForPool(pool, chainId);
    if (!spoke) return null;
    if (!(await boundOnChain(spoke, chainId, ctx))) return null;

    const target: DepositTarget = {
      kind: "erc4626",
      vault: spoke.vault.toLowerCase() as Address,
      asset: spoke.asset.toLowerCase() as Address,
    };
    // tvlUsd: 0 turns off only the TVL band (see the file comment); every
    // other ERC-4626 check runs as usual.
    return (await ctx.validate(target, { ...pool, tvlUsd: 0 })) ? target : null;
  },
};
