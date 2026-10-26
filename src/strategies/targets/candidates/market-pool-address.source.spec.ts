import type { DeFiLlamaYieldPool } from "../../external/defillama.client";
import type { Address, ResolverContext } from "../types";
import { marketPoolAddressCandidate } from "./market-pool-address.source";
import {
  type CandidateSource,
  candidateForPool,
  independentSourcesAgree,
  registerCandidateSource,
  resetCandidateSources,
} from "./registry";

/**
 * The market API stands in for DeFiLlama's paid `/poolsOld`. What it hands
 * back is a candidate, so these cases pin the refusals: a stale run, an entry
 * for some other pool, the deposited token itself, a method we do not know,
 * and two trusted sources naming different vaults.
 */

const VAULT = "0x2222222222222222222222222222222222222222";
const OTHER_VAULT = "0x3333333333333333333333333333333333333333";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function pool(overrides: Partial<DeFiLlamaYieldPool> = {}): DeFiLlamaYieldPool {
  return {
    pool: "8230dac6-31e8-5957-b442-90509858cc68",
    chain: "Monad",
    project: "some-vaults",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 4,
    ilRisk: "no",
    exposure: "single",
    underlyingTokens: [USDC],
    ...overrides,
  };
}

function ctxAnswering(body: unknown) {
  const fetchJsonCached = jest.fn(async () => body);
  return {
    ctx: {
      fetchJsonCached,
      validate: async () => true,
    } as unknown as ResolverContext,
    fetchJsonCached,
  };
}

const answer = (entry: Record<string, unknown>, ageSeconds = 3_600) => ({
  status: "success",
  ownRun: { ageSeconds },
  entries: [
    {
      pool: pool().pool,
      chain: "Monad",
      address: VAULT,
      method: "uuidv5",
      ...entry,
    },
  ],
});

beforeEach(() => {
  process.env.MARKET_API_URL = "https://market.example/";
  process.env.MARKET_API_KEY = "test-secret-key";
  delete process.env.MARKET_POOL_ADDRESS_MAX_AGE_HOURS;
});

describe("marketPoolAddressCandidate", () => {
  it("returns the paired address, asking with the key in a header", async () => {
    const { ctx, fetchJsonCached } = ctxAnswering(answer({}));
    expect(await marketPoolAddressCandidate(pool(), ctx)).toBe(VAULT);
    const [, url, , init] = fetchJsonCached.mock.calls[0] as unknown as [
      string,
      string,
      number,
      { headers: Record<string, string>; cacheIf: (b: unknown) => boolean },
    ];
    expect(url).toBe("https://market.example/api/pool-addresses/some-vaults");
    expect(url).not.toContain("test-secret-key");
    expect(init.headers["X-API-Key"]).toBe("test-secret-key");
    expect(init.cacheIf({ status: "pending" })).toBe(false);
  });

  it("is silent without config", async () => {
    delete process.env.MARKET_API_KEY;
    const { ctx, fetchJsonCached } = ctxAnswering(answer({}));
    expect(await marketPoolAddressCandidate(pool(), ctx)).toBeNull();
    expect(fetchJsonCached).not.toHaveBeenCalled();
  });

  it.each([
    ["a run older than the limit", answer({}, 4 * 24 * 3600)],
    ["an entry for another pool", answer({ pool: "some-other-uuid" })],
    ["an entry on another chain", answer({ chain: "Ethereum" })],
    ["the deposited token itself", answer({ address: USDC })],
    ["a method we do not trust", answer({ method: "guess" })],
    ["a pending answer", { status: "pending" }],
  ])("refuses %s", async (_label, body) => {
    const { ctx } = ctxAnswering(body);
    expect(await marketPoolAddressCandidate(pool(), ctx)).toBeNull();
  });
});

describe("independentSourcesAgree", () => {
  const fixed = (
    id: string,
    address: string | null,
    corroborates = true,
  ): CandidateSource => ({
    id,
    projects: id === "protocol-own" ? ["some-vaults"] : "*",
    corroborates,
    candidate: async () => address as Address | null,
  });
  const ctx = {} as ResolverContext;

  afterEach(() => resetCandidateSources());

  it("refuses when a corroborating source names a different vault", async () => {
    registerCandidateSource(fixed("protocol-own", VAULT, false));
    registerCandidateSource(fixed("market", OTHER_VAULT));
    const first = await candidateForPool(pool(), ctx);
    expect(first).toEqual({ address: VAULT, sourceId: "protocol-own" });
    expect(await independentSourcesAgree(pool(), ctx, first!)).toBe(false);
  });

  it("accepts agreement, case-insensitively, and an abstaining source", async () => {
    registerCandidateSource(fixed("protocol-own", VAULT, false));
    registerCandidateSource(
      fixed("market", VAULT.toUpperCase().replace("0X", "0x")),
    );
    registerCandidateSource(fixed("deep-link", null));
    const first = await candidateForPool(pool(), ctx);
    expect(await independentSourcesAgree(pool(), ctx, first!)).toBe(true);
  });

  it("does not ask a source that does not corroborate", async () => {
    registerCandidateSource(fixed("protocol-own", VAULT, false));
    registerCandidateSource(fixed("deep-link", OTHER_VAULT, false));
    const first = await candidateForPool(pool(), ctx);
    expect(await independentSourcesAgree(pool(), ctx, first!)).toBe(true);
  });
});
