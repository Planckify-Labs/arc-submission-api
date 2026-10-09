import { BridgeService } from "./bridge.service";
import { registerBridgeAdapter, resetBridgeAdapters } from "./registry";
import type { BridgeQuote } from "./types";

/**
 * Swap spec §4.3 (arbitration) and §4.7 (chain reach is ours).
 */
const BASE = "eip155:8453";
const ARB = "eip155:42161";
const req = {
  fromChain: BASE,
  toChain: BASE,
  fromAsset: `${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`,
  toAsset: `${BASE}/erc20:0x4200000000000000000000000000000000000006`,
  amountRaw: "1000000",
  fromAddress: "0x3333333333333333333333333333333333333333",
  toAddress: "0x3333333333333333333333333333333333333333",
};

function adapter(
  key: string,
  opts: {
    min?: string;
    fail?: boolean;
    specific?: boolean;
    chains?: string[];
    /** Symbols this adapter's resolveToken reports, by asset id. */
    symbols?: Record<string, string>;
  } = {},
) {
  const quote = jest.fn(async () => {
    if (opts.fail) throw new Error(`${key} down`);
    return {
      provider: key,
      toAmountMinRaw: opts.min ?? "1",
      from: { token: { caip19: req.fromAsset, verification: "unknown" } },
      to: { token: { caip19: req.toAsset, verification: "unverified" } },
    } as unknown as BridgeQuote;
  });
  return {
    key,
    kinds: ["swap", "bridge"] as const,
    supports: () => true,
    ...(opts.specific ? { supportsAsset: () => true } : {}),

    quote,
    status: jest.fn(),
    resolveToken: jest.fn(async (asset: string) =>
      opts.symbols?.[asset] ? { symbol: opts.symbols[asset] } : null,
    ),
    listSupportedChains: async () =>
      (opts.chains ?? [BASE, ARB]).map((chain) => ({ chain, name: chain, providers: [key] })),
    listTools: async () => [],
  } as never as ReturnType<typeof Object> & { quote: jest.Mock };
}

function prismaWith(rows: object[] | Error, tokens: object[] = []) {
  return {
    blockchain: {
      findMany: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      }),
    },
    token: { findMany: jest.fn(async () => tokens) },
  } as never;
}

const baseRow = { type: "EVM", chainId: 8453, chainSlug: null, name: "Base" };

describe("BridgeService arbitration (§4.3)", () => {
  afterEach(() => resetBridgeAdapters());

  it("keeps the best guaranteed floor, not the first answer", async () => {
    registerBridgeAdapter(adapter("a", { min: "900" }) as never);
    registerBridgeAdapter(adapter("b", { min: "950" }) as never);
    const r = await new BridgeService().quote(req);
    expect(r.routable && r.quote.provider).toBe("b");
  });

  it("breaks ties to registration order", async () => {
    registerBridgeAdapter(adapter("a", { min: "950" }) as never);
    registerBridgeAdapter(adapter("b", { min: "950" }) as never);
    const r = await new BridgeService().quote(req);
    expect(r.routable && r.quote.provider).toBe("a");
  });

  it("falls through to the survivor when one provider fails", async () => {
    registerBridgeAdapter(adapter("a", { fail: true }) as never);
    registerBridgeAdapter(adapter("b", { min: "10" }) as never);
    const r = await new BridgeService().quote(req);
    expect(r.routable && r.quote.provider).toBe("b");
  });

  it("never races a specialist against the generalist: the generalist is only its fallback", async () => {
    const generalist = adapter("lifi", { min: "999999" });
    registerBridgeAdapter(generalist as never);
    registerBridgeAdapter(adapter("circle", { min: "1", specific: true }) as never);
    const r = await new BridgeService().quote(req);
    expect(r.routable && r.quote.provider).toBe("circle");
    expect(generalist.quote).not.toHaveBeenCalled();
  });
});

describe("BridgeService swap routing policy (co-marketing)", () => {
  afterEach(() => resetBridgeAdapters());
  const symbols = { [req.fromAsset]: "USDC", [req.toAsset]: "WETH" };
  const config = (env: Record<string, string>) =>
    ({ get: (k: string) => env[k] }) as never;
  // Base USDC is in our catalogue: the policy's symbol match only counts
  // for a contract we vouch for on that chain.
  const vouched = () =>
    prismaWith(
      [baseRow],
      [{ contractAddress: req.fromAsset.split(":").pop(), blockchain: baseRow }],
    );

  it("sends a preferred-token swap to Tower even when LI.FI quotes better", async () => {
    const lifi = adapter("lifi", { min: "999999", symbols });
    registerBridgeAdapter(adapter("tower", { min: "1", symbols }) as never);
    registerBridgeAdapter(lifi as never);
    const r = await new BridgeService(vouched()).quote(req);
    expect(r.routable && r.quote.provider).toBe("tower");
    expect(lifi.quote).not.toHaveBeenCalled();
  });

  it("falls back to LI.FI when Tower cannot route", async () => {
    registerBridgeAdapter(adapter("tower", { fail: true, symbols }) as never);
    registerBridgeAdapter(adapter("lifi", { min: "5", symbols }) as never);
    const r = await new BridgeService(vouched()).quote(req);
    expect(r.routable && r.quote.provider).toBe("lifi");
  });

  it("is 'no route' when every preferred provider declines", async () => {
    registerBridgeAdapter(adapter("tower", { fail: true, symbols }) as never);
    registerBridgeAdapter(adapter("lifi", { fail: true, symbols }) as never);
    const r = await new BridgeService(vouched()).quote(req);
    expect(r.routable).toBe(false);
  });

  it("after the co-marketing: LI.FI only, Tower retired, by env alone", async () => {
    const tower = adapter("tower", { min: "999999", symbols });
    registerBridgeAdapter(tower as never);
    registerBridgeAdapter(adapter("lifi", { min: "5", symbols }) as never);
    const svc = new BridgeService(
      vouched(),
      undefined,
      config({ SWAP_PREFERRED_PROVIDERS: "lifi", DISABLED_ROUTE_PROVIDERS: "tower" }),
    );
    const preferred = await svc.quote(req);
    expect(preferred.routable && preferred.quote.provider).toBe("lifi");
    // A non-preferred token on the same chain no longer reaches Tower either.
    const other = await svc.quote({ ...req, fromAsset: req.toAsset, toAsset: req.fromAsset });
    expect(other.routable && other.quote.provider).toBe("lifi");
    expect(tower.quote).not.toHaveBeenCalled();
  });

  it("a disabled provider is also the incident kill switch for open routes", async () => {
    const lifi = adapter("lifi", { min: "999999" });
    registerBridgeAdapter(adapter("other", { min: "1" }) as never);
    registerBridgeAdapter(lifi as never);
    const r = await new BridgeService(
      vouched(),
      undefined,
      config({ DISABLED_ROUTE_PROVIDERS: "lifi" }),
    ).quote(req);
    expect(r.routable && r.quote.provider).toBe("other");
    expect(lifi.quote).not.toHaveBeenCalled();
  });

  it("Tower serves only the co-marketing tokens: any other token goes to LI.FI", async () => {
    const other = { [req.fromAsset]: "WBTC", [req.toAsset]: "WETH" };
    const tower = adapter("tower", { min: "999999", symbols: other });
    registerBridgeAdapter(tower as never);
    registerBridgeAdapter(adapter("lifi", { min: "5", symbols: other }) as never);
    const r = await new BridgeService(vouched()).quote(req);
    expect(r.routable && r.quote.provider).toBe("lifi");
    expect(tower.quote).not.toHaveBeenCalled();
  });

  it("clearing ROUTE_POLICY_ONLY_PROVIDERS lets Tower compete openly", async () => {
    const other = { [req.fromAsset]: "WBTC", [req.toAsset]: "WETH" };
    registerBridgeAdapter(adapter("tower", { min: "999999", symbols: other }) as never);
    registerBridgeAdapter(adapter("lifi", { min: "5", symbols: other }) as never);
    const r = await new BridgeService(
      vouched(),
      undefined,
      config({ ROUTE_POLICY_ONLY_PROVIDERS: "" }),
    ).quote(req);
    expect(r.routable && r.quote.provider).toBe("tower");
  });

  it("an empty symbol list turns the co-marketing lane off: LI.FI for everything", async () => {
    const tower = adapter("tower", { min: "999999", symbols });
    registerBridgeAdapter(tower as never);
    registerBridgeAdapter(adapter("lifi", { min: "5" }) as never);
    const r = await new BridgeService(
      vouched(),
      undefined,
      config({ SWAP_PREFERRED_SYMBOLS: "" }),
    ).quote(req);
    expect(r.routable && r.quote.provider).toBe("lifi");
    expect(tower.quote).not.toHaveBeenCalled();
  });

  it("a lookalike with a preferred SYMBOL but an unvouched address never takes the Tower lane", async () => {
    const tower = adapter("tower", { min: "999999", symbols });
    registerBridgeAdapter(tower as never);
    registerBridgeAdapter(adapter("lifi", { min: "5", symbols }) as never);
    // Same symbols, but no Token row and no Circle pin for this contract.
    const r = await new BridgeService(prismaWith([baseRow], [])).quote(req);
    expect(r.routable && r.quote.provider).toBe("lifi");
    expect(tower.quote).not.toHaveBeenCalled();
  });

  it("a chain's native asset with a preferred symbol takes the lane (no contract to spoof)", async () => {
    const native = `${BASE}/slip44:60`;
    const nativeReq = { ...req, fromAsset: native };
    const nativeSymbols = { [native]: "USDC", [req.toAsset]: "WETH" };
    registerBridgeAdapter(adapter("tower", { min: "1", symbols: nativeSymbols }) as never);
    registerBridgeAdapter(adapter("lifi", { min: "999999", symbols: nativeSymbols }) as never);
    const r = await new BridgeService(prismaWith([baseRow], [])).quote(nativeReq);
    expect(r.routable && r.quote.provider).toBe("tower");
  });
});

describe("BridgeService chain reach (§4.7)", () => {
  afterEach(() => resetBridgeAdapters());

  it("refuses a chain with no active Blockchain row, before any provider call", async () => {
    const a = adapter("a");
    registerBridgeAdapter(a as never);
    const svc = new BridgeService(prismaWith([baseRow]));
    const r = await svc.quote({ ...req, toChain: ARB, toAsset: `${ARB}/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831` });
    expect(r).toEqual({ routable: false, reason: "chain_not_enabled" });
    expect(a.quote).not.toHaveBeenCalled();
  });

  it("intersects the support matrix with our rows", async () => {
    registerBridgeAdapter(adapter("a") as never);
    const support = await new BridgeService(prismaWith([baseRow])).getSupport();
    expect(support.chains.map((c) => c.chain)).toEqual([BASE]);
    expect(support.degraded).toBe(false);
  });

  it("degrades, never empties, when the rows cannot be read", async () => {
    registerBridgeAdapter(adapter("a") as never);
    const support = await new BridgeService(prismaWith(new Error("db down"))).getSupport();
    expect(support.degraded).toBe(true);
    expect(support.chains.length).toBe(2);
  });
});

describe("BridgeService token trust", () => {
  afterEach(() => resetBridgeAdapters());
  const WETH = "0x4200000000000000000000000000000000000006";

  it("vouches for a token the issuer pins, over a provider's 'unverified'", async () => {
    registerBridgeAdapter(adapter("lifi") as never);
    const circle = {
      bridgeChains: () => [
        { type: "evm", chainId: 8453, isTestnet: false, usdcAddress: null, eurcAddress: WETH },
      ],
    } as never;
    const r = await new BridgeService(undefined, circle).quote(req);
    expect(r.routable && r.quote.to.token.verification).toBe("verified");
  });

  it("vouches for a token in our own catalogue", async () => {
    registerBridgeAdapter(adapter("lifi") as never);
    const prisma = prismaWith([baseRow], [
      { contractAddress: WETH.toUpperCase().replace("0X", "0x"), blockchain: baseRow },
    ]);
    const r = await new BridgeService(prisma).quote(req);
    expect(r.routable && r.quote.to.token.verification).toBe("verified");
  });

  it("leaves a token neither source knows as the provider said", async () => {
    registerBridgeAdapter(adapter("lifi") as never);
    const r = await new BridgeService(prismaWith([baseRow], [])).quote(req);
    expect(r.routable && r.quote.to.token.verification).toBe("unverified");
  });
});

describe("BridgeService USD enrichment", () => {
  afterEach(() => resetBridgeAdapters());
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  function priced(price: number | null) {
    return {
      getPricesByAddress: jest.fn(async (pairs: { network: string; address: string }[]) =>
        new Map(pairs.map((p) => [`${p.network}:${p.address.toLowerCase()}`, price])),
      ),
    } as never;
  }

  function withSides() {
    const a = adapter("dex");
    a.quote.mockImplementation(async () => ({
      provider: "dex",
      toAmountMinRaw: "1",
      from: { amountRaw: "500000", token: { caip19: `${BASE}/erc20:${USDC_BASE}`, address: USDC_BASE, decimals: 6, verification: "verified" } },
      to: { amountRaw: "500000", amountUsd: "0.57", token: { caip19: `${BASE}/erc20:${USDC_BASE}`, address: USDC_BASE, decimals: 6, verification: "verified" } },
    }));
    return a;
  }

  it("fills a missing USD value from Alchemy, keeping a provider's own", async () => {
    registerBridgeAdapter(withSides() as never);
    const r = await new BridgeService(undefined, undefined, undefined, priced(1)).quote(req);
    expect(r.routable && r.quote.from.amountUsd).toBe("0.50");
    expect(r.routable && r.quote.to.amountUsd).toBe("0.57");
  });

  it("leaves USD absent when there is no price, never 0", async () => {
    registerBridgeAdapter(withSides() as never);
    const r = await new BridgeService(undefined, undefined, undefined, priced(null)).quote(req);
    expect(r.routable && r.quote.from.amountUsd).toBeUndefined();
  });

  it("without an Alchemy key, takes price and logo from an adapter's token data", async () => {
    const dex = withSides();
    const lifi = adapter("lifi");
    lifi.resolveToken.mockImplementation(async () => ({
      priceUsd: "1.0004",
      logoUri: "https://example.com/usdc.png",
    }));
    registerBridgeAdapter(dex as never);
    registerBridgeAdapter(lifi as never);
    const r = await new BridgeService().quote(req);
    expect(r.routable && r.quote.from.amountUsd).toBe("0.50");
    expect(r.routable && r.quote.from.token.logoUri).toBe("https://example.com/usdc.png");
    // The provider's own USD figure is never overwritten.
    expect(r.routable && r.quote.to.amountUsd).toBe("0.57");
  });
});

describe("BridgeService token search", () => {
  afterEach(() => resetBridgeAdapters());
  const ARC = "eip155:5042";
  const CIRBTC = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0";
  const arcRow = { type: "EVM", chainId: 5042, chainSlug: null, name: "Arc" };

  function searcher(found: object[]) {
    const a = adapter("lifi");
    (a as unknown as { searchTokens: jest.Mock }).searchTokens = jest.fn(async () => found);
    return a;
  }

  it("finds a token with no catalogue row through a provider (§4.6)", async () => {
    registerBridgeAdapter(
      searcher([{ caip19: `${ARC}/erc20:${CIRBTC}`, symbol: "cirBTC", decimals: 8, verification: "unverified" }]) as never,
    );
    const found = await new BridgeService(prismaWith([arcRow], [])).searchTokens(ARC, "cirbtc");
    expect(found).toHaveLength(1);
    expect(found[0].symbol).toBe("cirBTC");
    expect(found[0].verification).toBe("unverified");
  });

  it("marks a result verified only when our catalogue vouches for it", async () => {
    registerBridgeAdapter(
      searcher([{ caip19: `${ARC}/erc20:${CIRBTC}`, symbol: "cirBTC", decimals: 8, verification: "unverified" }]) as never,
    );
    const prisma = prismaWith([arcRow], [{ contractAddress: CIRBTC, blockchain: arcRow }]);
    const found = await new BridgeService(prisma).searchTokens(ARC, "cirBTC");
    expect(found[0].verification).toBe("verified");
  });

  it("never searches a chain we do not serve", async () => {
    const a = searcher([{ caip19: `${ARC}/erc20:${CIRBTC}`, symbol: "cirBTC", decimals: 8 }]);
    registerBridgeAdapter(a as never);
    const found = await new BridgeService(prismaWith([baseRow], [])).searchTokens(ARC, "cirBTC");
    expect(found).toEqual([]);
  });
});

describe("BridgeService exact-id token check", () => {
  afterEach(() => resetBridgeAdapters());
  const ARC = "eip155:5042";
  const arcRow = { type: "EVM", chainId: 5042, chainSlug: null, name: "Arc" };

  it("answers a real token id through any adapter that can read it", async () => {
    const a = adapter("tower");
    a.resolveToken.mockImplementation(async (asset: string) => ({
      caip19: asset,
      symbol: "cirBTC",
      decimals: 8,
      verification: "unknown",
    }));
    registerBridgeAdapter(a as never);
    const id = `${ARC}/erc20:0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`;
    const found = await new BridgeService(prismaWith([arcRow], [])).searchTokens(ARC, id);
    expect(found.map((t) => t.symbol)).toEqual(["cirBTC"]);
  });

  it("answers nothing for an id no adapter can read (a made-up address)", async () => {
    registerBridgeAdapter(adapter("tower") as never);
    const id = `${ARC}/erc20:0x17C8F1DE68Ab1e738250E650e46C372abc34a983`;
    expect(await new BridgeService(prismaWith([arcRow], [])).searchTokens(ARC, id)).toEqual([]);
  });
});

describe("BridgeService reach (bridge picker validation)", () => {
  afterEach(() => resetBridgeAdapters());
  const OP = "eip155:10";
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const rows = [
    baseRow,
    { type: "EVM", chainId: 42161, chainSlug: null, name: "Arbitrum" },
    { type: "EVM", chainId: 10, chainSlug: null, name: "Optimism" },
  ];
  const pairAdapter = (key: string, pairs: Array<[string, string]>) => ({
    ...(adapter(key, { chains: [BASE, ARB, OP, SOL] }) as object),
    supports: (from: string, to: string) =>
      pairs.some(([a, b]) => a === from && b === to),
  });

  it("offers only enabled chains some provider serves FROM the source", async () => {
    registerBridgeAdapter(
      pairAdapter("a", [
        [BASE, ARB],
        [ARB, OP],
        [BASE, SOL],
      ]) as never,
    );
    const r = await new BridgeService(prismaWith(rows)).reach(BASE);
    // ARB: served from Base. OP: only served from ARB, not Base. SOL: served
    // but not one of our enabled chains.
    expect(r.destinations.map((d) => d.chain)).toEqual([ARB]);
    expect(r.swap).toBe(false);
  });

  it("ignores a provider switched off by config", async () => {
    registerBridgeAdapter(pairAdapter("off", [[BASE, ARB]]) as never);
    const config = {
      get: (k: string) => (k === "DISABLED_ROUTE_PROVIDERS" ? "off" : undefined),
    };
    const r = await new BridgeService(
      prismaWith(rows),
      undefined,
      config as never,
    ).reach(BASE);
    expect(r.destinations).toEqual([]);
  });

  it("reports swaps where a provider serves the same chain", async () => {
    registerBridgeAdapter(pairAdapter("dex", [[BASE, BASE]]) as never);
    const r = await new BridgeService(prismaWith(rows)).reach(BASE);
    expect(r.swap).toBe(true);
    expect(r.destinations).toEqual([]);
  });

  it("offers nothing from a chain we do not serve", async () => {
    registerBridgeAdapter(pairAdapter("a", [[SOL, BASE]]) as never);
    const r = await new BridgeService(prismaWith(rows)).reach(SOL);
    expect(r).toMatchObject({ swap: false, destinations: [] });
  });
});

describe("BridgeService listTokens (token picker)", () => {
  afterEach(() => resetBridgeAdapters());
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const token = (address: string, symbol: string, isNative = false) => ({
    caip19: isNative ? `${BASE}/slip44:60` : `${BASE}/erc20:${address}`,
    chain: BASE,
    address,
    symbol,
    decimals: 6,
    isNative,
    verification: "unknown" as const,
  });

  it("vouches catalogue tokens, puts native and verified first, dedupes", async () => {
    const list = [
      token("0x1111111111111111111111111111111111111111", "MEME"),
      token(USDC, "USDC"),
      token("", "ETH", true),
      token(USDC.toUpperCase().replace("0X", "0x"), "USDC"),
    ];
    registerBridgeAdapter({
      ...(adapter("lifi") as object),
      listTokens: async () => list,
    } as never);
    const prisma = prismaWith([baseRow], [
      { contractAddress: USDC, blockchain: baseRow },
    ]);
    const out = await new BridgeService(prisma).listTokens(BASE);
    expect(out.map((t) => t.symbol)).toEqual(["ETH", "USDC", "MEME"]);
    expect(out[1].verification).toBe("verified");
    expect(out[2].verification).toBe("unknown");
  });

  it("returns nothing for a chain we do not serve", async () => {
    registerBridgeAdapter({
      ...(adapter("lifi") as object),
      listTokens: async () => [token(USDC, "USDC")],
    } as never);
    const out = await new BridgeService(prismaWith([baseRow])).listTokens(ARB);
    expect(out).toEqual([]);
  });
});

describe("signing-time re-quote holds the approved floor", () => {
  afterEach(() => resetBridgeAdapters());

  it("passes the approved minimum through to the adapters, in one round trip", async () => {
    const a = adapter("dex", { min: "1" });
    registerBridgeAdapter(a as never);
    await new BridgeService().quote({ ...req, minReceiveRaw: "2131803" });
    expect(a.quote).toHaveBeenCalledTimes(1);
    expect(a.quote.mock.calls[0][0]).toMatchObject({ minReceiveRaw: "2131803" });
  });
});

describe("validated route tokens and network tiers", () => {
  afterEach(() => resetBridgeAdapters());
  const BASE_SEP = "eip155:84532";
  const ARB_SEP = "eip155:421614";
  const rows = [
    { type: "EVM", chainId: 84532, chainSlug: null, name: "Base Sepolia", isTestnet: true },
    { type: "EVM", chainId: 421614, chainSlug: null, name: "Arbitrum Sepolia", isTestnet: true },
    { type: "EVM", chainId: 42161, chainSlug: null, name: "Arbitrum", isTestnet: false },
  ];
  const tok = (chain: string, symbol: string, address: string) => ({
    caip19: `${chain}/erc20:${address}`,
    chain,
    address,
    symbol,
    decimals: 6,
    isNative: false,
    verification: "unknown" as const,
  });
  const usdcBase = tok(BASE_SEP, "USDC", "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  const usdcArb = tok(ARB_SEP, "USDC", "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
  const everywhere = (key: string, extra: object = {}) => ({
    ...(adapter(key, { chains: [BASE_SEP, ARB_SEP, "eip155:42161"] }) as object),
    supports: () => true,
    ...extra,
  });

  it("never offers a destination on the other network tier", async () => {
    registerBridgeAdapter(everywhere("lifi") as never);
    const r = await new BridgeService(prismaWith(rows)).reach(BASE_SEP);
    expect(r.destinations.map((d) => d.chain)).toEqual([ARB_SEP]);
  });

  it("refuses to quote across tiers even if a provider says it can", async () => {
    registerBridgeAdapter(everywhere("lifi") as never);
    const r = await new BridgeService(prismaWith(rows)).quote({
      ...req,
      fromChain: BASE_SEP,
      toChain: "eip155:42161",
      fromAsset: usdcBase.caip19,
      toAsset: "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    });
    expect(r).toEqual({ routable: false, reason: "chain_not_supported" });
  });

  it("offers only the pairs providers route, App Kit's first", async () => {
    registerBridgeAdapter(
      everywhere("circle-cctp", {
        listRoutablePairs: async () => [{ from: usdcBase, to: usdcArb }],
      }) as never,
    );
    registerBridgeAdapter(
      everywhere("lifi", {
        listRoutablePairs: async () => [{ from: usdcBase, to: usdcArb }],
      }) as never,
    );
    const r = await new BridgeService(prismaWith(rows)).routeTokens(BASE_SEP, ARB_SEP);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].providers).toEqual(["circle-cctp", "lifi"]);
    expect(r.degraded).toBe(false);
  });

  it("leaves out a provider it cannot check, and says so", async () => {
    registerBridgeAdapter(
      everywhere("lifi", {
        listRoutablePairs: async () => {
          throw new Error("li.fi down");
        },
      }) as never,
    );
    const r = await new BridgeService(prismaWith(rows)).routeTokens(BASE_SEP, ARB_SEP);
    expect(r).toMatchObject({ pairs: [], degraded: true });
  });

  it("returns nothing across tiers", async () => {
    registerBridgeAdapter(
      everywhere("lifi", { listRoutablePairs: async () => [{ from: usdcBase, to: usdcArb }] }) as never,
    );
    const r = await new BridgeService(prismaWith(rows)).routeTokens(BASE_SEP, "eip155:42161");
    expect(r.pairs).toEqual([]);
  });

  it("swap: a policy-only provider offers only the vouched preferred tokens", async () => {
    const ARC_T = "eip155:5042002";
    const arcRows = [{ type: "EVM", chainId: 5042002, chainSlug: null, name: "Arc Testnet", isTestnet: true }];
    const arcRow = arcRows[0];
    const catalogue = [
      { contractAddress: "0x3600000000000000000000000000000000000000", symbol: "USDC", name: "USD Coin", decimals: 6, logoUrl: null, blockchain: arcRow },
      { contractAddress: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF", symbol: "cirBTC", name: "Circle Wrapped Bitcoin", decimals: 8, logoUrl: null, blockchain: arcRow },
      { contractAddress: "0x1111111111111111111111111111111111111111", symbol: "MEME", name: "Meme", decimals: 18, logoUrl: null, blockchain: arcRow },
    ];
    registerBridgeAdapter({
      ...(adapter("tower", { chains: [ARC_T] }) as object),
      supports: (a: string, b: string) => a === ARC_T && b === ARC_T,
    } as never);
    const r = await new BridgeService(prismaWith(arcRows, catalogue)).routeTokens(ARC_T, ARC_T);
    expect(r.tokens.map((t) => t.symbol).sort()).toEqual(["USDC", "cirBTC"]);
    expect(r.tokens.every((t) => t.verification === "verified")).toBe(true);
  });
});

describe("optional per-chain token limit", () => {
  afterEach(() => resetBridgeAdapters());
  const BASE_SEP = "eip155:84532";
  const ARB_SEP = "eip155:421614";
  const ARC = "eip155:5042";
  const rows = [
    { type: "EVM", chainId: 84532, chainSlug: null, name: "Base Sepolia", isTestnet: true },
    { type: "EVM", chainId: 421614, chainSlug: null, name: "Arbitrum Sepolia", isTestnet: true },
    { type: "EVM", chainId: 5042, chainSlug: null, name: "Arc", isTestnet: false },
  ];
  const t = (chain: string, symbol: string, address: string, verification: "verified" | "unknown") => ({
    caip19: `${chain}/erc20:${address}`, chain, address, symbol, decimals: 6, isNative: false, verification,
  });
  const config = (env: Record<string, string>) => ({ get: (k: string) => env[k] });

  it("unset (the default), every provider-validated token is offered", async () => {
    registerBridgeAdapter({
      ...(adapter("lifi", { chains: [BASE_SEP, ARB_SEP] }) as object),
      supports: () => true,
      listRoutablePairs: async () => [
        { from: t(BASE_SEP, "USDC", "0x036c", "verified"), to: t(ARB_SEP, "USDC", "0x75fa", "verified") },
        { from: t(BASE_SEP, "WETH", "0x4200", "unknown"), to: t(ARB_SEP, "WETH", "0x980b", "unknown") },
      ],
    } as never);
    const r = await new BridgeService(prismaWith(rows), undefined, config({}) as never).routeTokens(BASE_SEP, ARB_SEP);
    expect(r.pairs.map((p) => p.from.symbol)).toEqual(["USDC", "WETH"]);
  });

  it("set for a chain, only its vouched symbols: no memecoins, no lookalikes", async () => {
    registerBridgeAdapter({
      ...(adapter("lifi", { chains: [ARC] }) as object),
      supports: () => true,
      listSwapTokens: async () => [
        t(ARC, "USDC", "0x3600", "verified"),
        t(ARC, "EURC", "0xbef5", "verified"),
        t(ARC, "ARCAT", "0xa4ca", "verified"),
        t(ARC, "USDC", "0xfake", "unknown"),
      ],
    } as never);
    const r = await new BridgeService(
      prismaWith(rows),
      undefined,
      config({ ROUTE_TOKEN_SYMBOLS_BY_CHAIN: "eip155:5042=USDC,EURC,cirBTC" }) as never,
    ).routeTokens(ARC, ARC);
    expect(r.tokens.map((x) => [x.symbol, x.address])).toEqual([
      ["USDC", "0x3600"],
      ["EURC", "0xbef5"],
    ]);
  });

  it("Arc is not limited by default", async () => {
    registerBridgeAdapter({
      ...(adapter("lifi", { chains: [ARC] }) as object),
      supports: () => true,
      listSwapTokens: async () => [t(ARC, "USDC", "0x3600", "verified"), t(ARC, "ARCAT", "0xa4ca", "unknown")],
    } as never);
    const lifted = await new BridgeService(prismaWith(rows), undefined, config({}) as never).routeTokens(ARC, ARC);
    expect(lifted.tokens.map((x) => x.symbol)).toEqual(["USDC", "ARCAT"]);
  });
});

describe("picker icons", () => {
  afterEach(() => resetBridgeAdapters());
  const BASE_SEP = "eip155:84532";
  const ARB_SEP = "eip155:421614";
  const baseSep = { type: "EVM", chainId: 84532, chainSlug: null, name: "Base Sepolia", isTestnet: true };
  const rows = [baseSep, { type: "EVM", chainId: 421614, chainSlug: null, name: "Arbitrum Sepolia", isTestnet: true }];
  const usdc = (chain: string, address: string, logoUri?: string) => ({
    caip19: `${chain}/erc20:${address}`, chain, address, symbol: "USDC", decimals: 6,
    isNative: false, verification: "verified" as const, ...(logoUri ? { logoUri } : {}),
  });

  it("fills a missing logo from Alchemy, then our catalogue, else leaves it for the symbol", async () => {
    registerBridgeAdapter({
      ...(adapter("circle-cctp", { chains: [BASE_SEP, ARB_SEP] }) as object),
      supports: () => true,
      listRoutablePairs: async () => [
        { from: usdc(BASE_SEP, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"), to: usdc(ARB_SEP, "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d") },
      ],
    } as never);
    const tokenMetadata = {
      getIdentity: jest.fn(async (chainId: number) => ({
        symbol: "USDC",
        logo: chainId === 84532 ? "https://static.alchemyapi.io/usdc.png" : null,
        decimals: 6,
      })),
    };
    const prisma = {
      ...(prismaWith(rows) as object),
      token: {
        findMany: jest.fn(async (args: { where?: { logoUrl?: unknown } }) =>
          args.where?.logoUrl
            ? [{ contractAddress: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", isNativeCurrency: false, logoUrl: "https://cdn.example/usdc-arb.png", blockchain: rows[1] }]
            : [],
        ),
      },
    };
    const r = await new BridgeService(prisma as never, undefined, undefined, undefined, tokenMetadata as never).routeTokens(BASE_SEP, ARB_SEP);
    expect(r.pairs[0].from.logoUri).toBe("https://static.alchemyapi.io/usdc.png");
    expect(r.pairs[0].to.logoUri).toBe("https://cdn.example/usdc-arb.png");
  });
});

describe("picker icons for vouched tokens", () => {
  afterEach(() => resetBridgeAdapters());
  const BASE_SEP = "eip155:84532";
  const ARB_SEP = "eip155:421614";
  const rows = [
    { type: "EVM", chainId: 84532, chainSlug: null, name: "Base Sepolia", isTestnet: true },
    { type: "EVM", chainId: 421614, chainSlug: null, name: "Arbitrum Sepolia", isTestnet: true },
  ];
  const eurc = (chain: string, address: string, verification: "verified" | "unknown") => ({
    caip19: `${chain}/erc20:${address}`, chain, address, symbol: "EURC", decimals: 6, isNative: false, verification,
  });

  it("a vouched token without an icon wears its asset's icon from another chain; a lookalike does not", async () => {
    registerBridgeAdapter({
      ...(adapter("circle-cctpx", { chains: [BASE_SEP, ARB_SEP] }) as object),
      supports: () => true,
      listRoutablePairs: async () => [
        { from: eurc(BASE_SEP, "0x808456652fdb597867f38412077a9182bf77359f", "verified"), to: eurc(ARB_SEP, "0x89b50855aa3be2f677cd6303cec089b5f319d72a", "unknown") },
      ],
    } as never);
    const arcLogo = "https://static.alchemyapi.io/images/assets/20641.png";
    const prisma = {
      ...(prismaWith(rows) as object),
      token: {
        findMany: jest.fn(async (args: { where?: { logoUrl?: unknown } }) =>
          args.where?.logoUrl
            ? [{ contractAddress: "0x1234000000000000000000000000000000000000", isNativeCurrency: false, symbol: "EURC", logoUrl: arcLogo, blockchain: rows[1] }]
            : [],
        ),
      },
    };
    const metadata = { getIdentity: jest.fn(async () => ({ symbol: null, logo: null, decimals: null })) };
    const r = await new BridgeService(
      prisma as never,
      undefined,
      undefined,
      undefined,
      metadata as never,
    ).routeTokens(BASE_SEP, ARB_SEP);
    expect(r.pairs[0].from.logoUri).toBe(arcLogo);
    expect(r.pairs[0].to.logoUri).toBeUndefined();
  });
});

describe("picker icons: Arc USDC is an ERC-20 even when flagged native", () => {
  afterEach(() => resetBridgeAdapters());
  it("uses the token's icon, not the chain's native-coin icon", async () => {
    const ARC_T = "eip155:5042002";
    const ARB_SEP = "eip155:421614";
    const rows = [
      { type: "EVM", chainId: 5042002, chainSlug: null, name: "Arc Testnet", isTestnet: true },
      { type: "EVM", chainId: 421614, chainSlug: null, name: "Arbitrum Sepolia", isTestnet: true },
    ];
    const arcUsdc = {
      caip19: `${ARC_T}/erc20:0x3600000000000000000000000000000000000000`,
      chain: ARC_T, address: "0x3600000000000000000000000000000000000000",
      symbol: "USDC", decimals: 6, isNative: true, verification: "verified" as const,
    };
    const arbUsdc = { ...arcUsdc, caip19: `${ARB_SEP}/erc20:0x75fa`, chain: ARB_SEP, address: "0x75fa", isNative: false };
    registerBridgeAdapter({
      ...(adapter("circle-cctp", { chains: [ARC_T, ARB_SEP] }) as object),
      supports: () => true,
      listRoutablePairs: async () => [{ from: arcUsdc, to: arbUsdc }],
    } as never);
    const prisma = {
      ...(prismaWith(rows) as object),
      token: {
        findMany: jest.fn(async (args: { where?: { logoUrl?: unknown } }) =>
          args.where?.logoUrl
            ? [
                { contractAddress: null, isNativeCurrency: true, symbol: "USDC", logoUrl: "https://cdn.example/arc-chain.png", blockchain: rows[0] },
                { contractAddress: "0x3600000000000000000000000000000000000000", isNativeCurrency: false, symbol: "USDC", logoUrl: "https://cdn.example/usdc.png", blockchain: rows[0] },
              ]
            : [],
        ),
      },
    };
    const metadata = { getIdentity: jest.fn(async () => ({ symbol: null, logo: null, decimals: null })) };
    const r = await new BridgeService(prisma as never, undefined, undefined, undefined, metadata as never).routeTokens(ARC_T, ARB_SEP);
    expect(r.pairs[0].from.logoUri).toBe("https://cdn.example/usdc.png");
  });
});
