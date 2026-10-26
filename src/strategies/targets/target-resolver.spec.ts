import type { DeFiLlamaYieldPool } from "../external/defillama.client";
import { AaveResolver } from "./aave.resolver";
import { bootTargetResolvers } from "./bootstrap";
import { loadChainDirectory } from "./chain-directory";
import { getResolverForProject, resolveTarget } from "./registry";
import type { ResolverContext } from "./types";

/**
 * Pool-target resolver registry + ERC-4626 / Aave resolvers
 * (docs/defi-pool-level-deposits-spec.md §3, §5). Network + on-chain
 * validation are stubbed via a fake ResolverContext so the matching logic is
 * tested in isolation. Fail-closed behaviour (→ null → manual) is the crux.
 */

const UNDERLYING = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

function morphoPool(
  overrides: Partial<DeFiLlamaYieldPool> = {},
): DeFiLlamaYieldPool {
  return {
    pool: "some-defillama-uuid",
    chain: "Ethereum",
    project: "morpho-blue",
    symbol: "USDC",
    tvlUsd: 1_000_000,
    apy: 5,
    ilRisk: "no",
    exposure: "single",
    poolMeta: "Steakhouse USDC",
    underlyingTokens: [UNDERLYING],
    ...overrides,
  };
}

function ctxWith(
  validate: boolean,
  vaults: Array<{ address: string; name: string; asset: { address: string } }>,
): ResolverContext {
  return {
    fetchJsonCached: async <T>(_key: string, url: string) => {
      if (url.includes("morpho")) {
        return {
          data: { vaults: { items: vaults } },
        } as unknown as T;
      }
      return [] as unknown as T;
    },
    validate: async () => validate,
  };
}

beforeAll(() => {
  // Chain support is data-driven (chain-directory.ts): `resolveEvmChainId`
  // reads the loaded `Blockchain` snapshot, so a spec has to seed it just as
  // `TargetResolverService` does at boot. An unloaded directory resolves every
  // chain to 0, which is the correct fail-closed default but not what these
  // cases are about.
  loadChainDirectory([
    {
      chainId: 1,
      name: "Ethereum",
      chainSlug: "ethereum",
      rpcUrl: "https://rpc.example/eth",
      family: "EVM",
      isTestnet: false,
    },
    {
      chainId: 8453,
      name: "Base",
      chainSlug: "base",
      rpcUrl: "https://rpc.example/base",
      family: "EVM",
      isTestnet: false,
    },
  ]);
  bootTargetResolvers();
});

describe("getResolverForProject", () => {
  it("routes DeFiLlama project slugs to their family resolver", () => {
    expect(getResolverForProject("morpho-blue")?.family).toBe("morpho");
    expect(getResolverForProject("yearn-finance")?.family).toBe("yearn");
    expect(getResolverForProject("aave-v3")?.family).toBe("aave");
  });

  it("returns null for an unregistered protocol (→ manual, correct-by-default)", () => {
    expect(getResolverForProject("some-brand-new-venue")).toBeNull();
    expect(getResolverForProject("")).toBeNull();
  });
});

describe("MorphoResolver via resolveTarget", () => {
  it("matches a whitelisted vault by underlying + poolMeta → erc4626 target", async () => {
    const ctx = ctxWith(true, [
      {
        address: VAULT,
        name: "Steakhouse USDC",
        asset: { address: UNDERLYING },
      },
    ]);
    const target = await resolveTarget(morphoPool(), ctx);
    expect(target).toEqual({
      kind: "erc4626",
      vault: VAULT.toLowerCase(),
      asset: UNDERLYING.toLowerCase(),
    });
  });

  it("fails closed to null when on-chain validation rejects", async () => {
    const ctx = ctxWith(false, [
      {
        address: VAULT,
        name: "Steakhouse USDC",
        asset: { address: UNDERLYING },
      },
    ]);
    expect(await resolveTarget(morphoPool(), ctx)).toBeNull();
  });

  it("fails closed when poolMeta names a vault that doesn't exist", async () => {
    const ctx = ctxWith(true, [
      { address: VAULT, name: "Gauntlet USDC", asset: { address: UNDERLYING } },
    ]);
    expect(
      await resolveTarget(morphoPool({ poolMeta: "Steakhouse USDC" }), ctx),
    ).toBeNull();
  });

  it("resolves a Morpho-listed Vault V2 and ignores an unlisted look-alike", async () => {
    const FAKE = "0x3333333333333333333333333333333333333333";
    const v2Ctx = (listed: boolean): ResolverContext => ({
      fetchJsonCached: async <T>(_key: string, url: string) =>
        (url.includes("morpho")
          ? {
              data: {
                vaults: { items: [] },
                vaultV2s: {
                  items: [
                    {
                      address: VAULT,
                      name: "Steakhouse USDC",
                      listed,
                      asset: { address: UNDERLYING },
                    },
                    {
                      address: FAKE,
                      name: "Steakhouse USDC",
                      listed: false,
                      asset: { address: UNDERLYING },
                    },
                  ],
                },
              },
            }
          : []) as unknown as T,
      validate: async () => true,
    });
    expect(await resolveTarget(morphoPool(), v2Ctx(true))).toEqual({
      kind: "erc4626",
      vault: VAULT.toLowerCase(),
      asset: UNDERLYING.toLowerCase(),
    });
    // Only unlisted vaults left: the copy never resolves, whatever its name.
    expect(await resolveTarget(morphoPool(), v2Ctx(false))).toBeNull();
  });

  it("fails closed when the pool has no underlying token address", async () => {
    const ctx = ctxWith(true, [
      {
        address: VAULT,
        name: "Steakhouse USDC",
        asset: { address: UNDERLYING },
      },
    ]);
    expect(
      await resolveTarget(morphoPool({ underlyingTokens: [] }), ctx),
    ).toBeNull();
  });
});

describe("AaveResolver", () => {
  it("emits an aave-v3 target for a known chain + underlying", async () => {
    const ctx = ctxWith(true, []);
    const target = await AaveResolver.resolve(
      morphoPool({ project: "aave-v3", chain: "Base" }),
      ctx,
    );
    expect(target).toMatchObject({
      kind: "aave-v3",
      asset: UNDERLYING.toLowerCase(),
    });
  });

  it("returns null for an unsupported chain", async () => {
    const ctx = ctxWith(true, []);
    expect(
      await AaveResolver.resolve(
        morphoPool({ project: "aave-v3", chain: "Fantom" }),
        ctx,
      ),
    ).toBeNull();
  });
});
