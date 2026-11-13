import { Prisma } from "@generated/prisma";
import type { PrismaService } from "../../prisma/prisma.service";
import type { ExchangeRateCacheService } from "../../valkey/services/exchange-rate-cache.service";
import {
  CHAINLINK_FX_FEEDS,
  IDR_ASSET,
  type ChainlinkFxFeedPin,
} from "./chainlink-feeds";
import {
  checkFeedRead,
  computePairRate,
  derivePairs,
  formatScaled,
  hasNewRound,
  type FeedReading,
  type FxPair,
  type RawFeedRead,
} from "./chainlink-fx";
import { ChainlinkFxSyncService } from "./chainlink-fx-sync.service";

const NOW_SEC = 1_794_000_000;
const pin = (key: string): ChainlinkFxFeedPin => {
  const p = CHAINLINK_FX_FEEDS.find((f) => f.key === key);
  if (!p) throw new Error(`no pin ${key}`);
  return p;
};
const usdcIdr: FxPair = {
  fromCurrency: "USDC",
  toCurrency: "IDR",
  region: "ID",
  asset: "USDC",
  quoteAsset: "IDR",
};

function reading(
  asset: string,
  answer: bigint,
  updatedAtSec = NOW_SEC - 60,
  decimals = 8,
): FeedReading {
  return { key: `x:${asset}/USD`, asset, answer, decimals, updatedAtSec };
}

describe("feed pins", () => {
  it("keys and (chain, address) are unique", () => {
    expect(new Set(CHAINLINK_FX_FEEDS.map((f) => f.key)).size).toBe(
      CHAINLINK_FX_FEEDS.length,
    );
    expect(
      new Set(
        CHAINLINK_FX_FEEDS.map(
          (f) => `${f.chainId}:${f.address.toLowerCase()}`,
        ),
      ).size,
    ).toBe(CHAINLINK_FX_FEEDS.length);
  });

  it("description matches the asset (catches a copy-pasted address)", () => {
    for (const f of CHAINLINK_FX_FEEDS) {
      expect(f.description).toBe(`${f.asset} / USD`);
    }
  });

  it("Arc is tried first wherever it has the asset", () => {
    for (const asset of new Set(CHAINLINK_FX_FEEDS.map((f) => f.asset))) {
      const chains = CHAINLINK_FX_FEEDS.filter((f) => f.asset === asset).map(
        (f) => f.chainId,
      );
      if (chains.includes(5042)) expect(chains[0]).toBe(5042);
    }
  });

  it("has an IDR leg", () => {
    expect(CHAINLINK_FX_FEEDS.some((f) => f.asset === IDR_ASSET)).toBe(true);
  });
});

describe("checkFeedRead", () => {
  const base: RawFeedRead = {
    description: "USDC / USD",
    decimals: 8,
    answer: 99_967_343n,
    updatedAtSec: BigInt(NOW_SEC - 3600),
  };

  it("accepts a fresh read of the pinned feed", () => {
    expect(checkFeedRead(pin("arc:USDC/USD"), base, NOW_SEC).ok).toBe(true);
  });

  it.each([
    ["wrong description", { description: "USDT / USD" }],
    ["wrong decimals", { decimals: 18 }],
    ["zero answer", { answer: 0n }],
    ["negative answer", { answer: -1n }],
    ["missing updatedAt", { updatedAtSec: 0n }],
    ["future updatedAt", { updatedAtSec: BigInt(NOW_SEC + 3600) }],
    [
      "stale beyond heartbeat + grace",
      { updatedAtSec: BigInt(NOW_SEC - 86_400 - 8_641) },
    ],
    ["below the USD peg band", { answer: 95_000_000n }],
    ["above the USD peg band", { answer: 104_000_000n }],
  ])("rejects %s", (_label, patch) => {
    expect(
      checkFeedRead(pin("arc:USDC/USD"), { ...base, ...patch }, NOW_SEC).ok,
    ).toBe(false);
  });

  it("does not apply a USD band to EURC or volatile assets", () => {
    expect(
      checkFeedRead(
        pin("arc:EURC/USD"),
        { ...base, description: "EURC / USD", answer: 110_801_600n },
        NOW_SEC,
      ).ok,
    ).toBe(true);
    expect(
      checkFeedRead(
        pin("arc:ETH/USD"),
        { ...base, description: "ETH / USD", answer: 312_345_000_000n },
        NOW_SEC,
      ).ok,
    ).toBe(true);
  });

  it("uses the feed's own heartbeat (IDR/USD on Base is hourly)", () => {
    const raw: RawFeedRead = {
      description: "IDR / USD",
      decimals: 8,
      answer: 5481n,
      updatedAtSec: BigInt(NOW_SEC - 3600 - 601),
    };
    expect(checkFeedRead(pin("base:IDR/USD"), raw, NOW_SEC).ok).toBe(false);
    expect(
      checkFeedRead(
        pin("base:IDR/USD"),
        { ...raw, updatedAtSec: BigInt(NOW_SEC - 3600) },
        NOW_SEC,
      ).ok,
    ).toBe(true);
  });

  it("band check handles 18-decimal feeds (AUSD)", () => {
    const raw: RawFeedRead = {
      description: "AUSD / USD",
      decimals: 18,
      answer: 999_800_000_000_000_000n,
      updatedAtSec: BigInt(NOW_SEC - 60),
    };
    expect(checkFeedRead(pin("eth:AUSD/USD"), raw, NOW_SEC).ok).toBe(true);
  });
});

describe("derivePairs", () => {
  it("prices listed tokens that have a feed; IDR only for stablecoins", () => {
    const pairs = derivePairs([
      { symbol: "USDC", isStablecoin: true },
      { symbol: "USDC", isStablecoin: true }, // same symbol on another chain
      { symbol: "ETH", isStablecoin: false },
      { symbol: "IDRX", isStablecoin: true }, // no feed
      { symbol: "XLM", isStablecoin: false }, // no feed
    ]);
    expect(
      pairs.map((p) => `${p.fromCurrency}→${p.toCurrency}@${p.region}`),
    ).toEqual(["ETH→USD@null", "USDC→USD@null", "USDC→IDR@ID"]);
  });

  it("keeps the stored symbol for fromCurrency but matches feeds case-insensitively", () => {
    const [usd] = derivePairs([{ symbol: "Usdg", isStablecoin: false }]);
    expect(usd).toMatchObject({ fromCurrency: "Usdg", asset: "USDG" });
  });

  it("never publishes a token named like the fiat leg", () => {
    expect(derivePairs([{ symbol: "IDR", isStablecoin: true }])).toEqual([]);
  });
});

describe("computePairRate", () => {
  it("divides asset/USD by IDR/USD in integer math, rounding down", () => {
    const readings = new Map([
      ["USDC", reading("USDC", 99_967_343n, NOW_SEC - 500)],
      ["IDR", reading("IDR", 5481n, NOW_SEC - 100)],
    ]);
    expect(computePairRate(usdcIdr, readings)).toEqual({
      ok: true,
      // 0.99967343 / 0.00005481 = 18238.88761174968...
      rate: "18238.88761174",
      inputsUpdatedAtSec: NOW_SEC - 100,
    });
  });

  it("mixes decimals (18-dec AUSD over 8-dec IDR)", () => {
    const readings = new Map([
      ["AUSD", reading("AUSD", 1_000_000_000_000_000_000n, NOW_SEC, 18)],
      ["IDR", reading("IDR", 5000n)],
    ]);
    const r = computePairRate(
      { ...usdcIdr, fromCurrency: "AUSD", asset: "AUSD" },
      readings,
    );
    expect(r.ok && r.rate).toBe("20000");
  });

  it("publishes a USD pair as the feed value", () => {
    const r = computePairRate(
      { fromCurrency: "EURC", toCurrency: "USD", region: null, asset: "EURC" },
      new Map([["EURC", reading("EURC", 110_801_600n)]]),
    );
    expect(r.ok && r.rate).toBe("1.108016");
  });

  it("refuses when the IDR leg is missing", () => {
    expect(
      computePairRate(
        usdcIdr,
        new Map([["USDC", reading("USDC", 99_967_343n)]]),
      ),
    ).toEqual({ ok: false, reason: "no valid feed for IDR" });
  });
});

describe("formatScaled / hasNewRound", () => {
  it("formats scaled integers", () => {
    expect(formatScaled(1_823_888_761_174n, 8)).toBe("18238.88761174");
    expect(formatScaled(100_000_000n, 8)).toBe("1");
    expect(formatScaled(5n, 8)).toBe("0.00000005");
  });

  it("writes only for rounds newer than the last row", () => {
    const last = new Date((NOW_SEC - 600) * 1000);
    expect(hasNewRound(NOW_SEC - 601, last)).toBe(false);
    expect(hasNewRound(NOW_SEC - 600, last)).toBe(false);
    expect(hasNewRound(NOW_SEC - 599, last)).toBe(true);
    expect(hasNewRound(NOW_SEC - 99_999, null)).toBe(true);
  });
});

// ── service ────────────────────────────────────────────────────────────────

function raw(asset: string, answer: bigint, ageSec = 500): RawFeedRead {
  return {
    description: `${asset} / USD`,
    decimals: 8,
    answer,
    updatedAtSec: BigInt(NOW_SEC - ageSec),
  };
}

const FRESH: Record<string, RawFeedRead | Error> = {
  "arc:USDC/USD": raw("USDC", 99_967_343n),
  "arc:EURC/USD": raw("EURC", 110_801_600n),
  "arc:ETH/USD": raw("ETH", 312_345_000_000n),
  "base:IDR/USD": raw("IDR", 5481n, 100),
};

const TOKENS = [
  { symbol: "USDC", isStablecoin: true },
  { symbol: "EURC", isStablecoin: true },
  { symbol: "ETH", isStablecoin: false },
  { symbol: "IDRX", isStablecoin: true },
];

class TestSync extends ChainlinkFxSyncService {
  readonly reads: string[] = [];
  constructor(
    prisma: PrismaService,
    cache: ExchangeRateCacheService,
    private readonly feeds: Record<string, RawFeedRead | Error>,
  ) {
    super(prisma, cache);
  }
  protected async readFeedRaw(p: ChainlinkFxFeedPin): Promise<RawFeedRead> {
    this.reads.push(p.key);
    const v = this.feeds[p.key];
    if (!v) throw new Error("rpc down");
    if (v instanceof Error) throw v;
    return v;
  }
}

function harness(
  opts: {
    feeds?: Record<string, RawFeedRead | Error>;
    tokens?: { symbol: string; isStablecoin: boolean }[];
    sourceActive?: boolean;
    lastChainlinkCreatedAt?: Date | null;
    currentMarkup?: string | null;
    createError?: Error;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    exchangeSource: {
      upsert: jest.fn(async () => ({
        id: "src_chainlink",
        isActive: opts.sourceActive ?? true,
      })),
      update: jest.fn(async () => ({})),
    },
    token: { findMany: jest.fn(async () => opts.tokens ?? TOKENS) },
    exchangeRate: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where.provider === "chainlink") {
            return opts.lastChainlinkCreatedAt
              ? { createdAt: opts.lastChainlinkCreatedAt }
              : null;
          }
          return opts.currentMarkup === undefined
            ? null
            : { markup: opts.currentMarkup };
        },
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.createError) throw opts.createError;
        created.push(data);
        return { id: created.length };
      }),
    },
  };
  const cache = { invalidateRate: jest.fn(async () => undefined) };
  const svc = new TestSync(
    prisma as unknown as PrismaService,
    cache as unknown as ExchangeRateCacheService,
    opts.feeds ?? FRESH,
  );
  return { svc, prisma, cache, created };
}

const NOW = new Date(NOW_SEC * 1000 + 30_000);
const label = (r: Record<string, unknown>) =>
  `${r.fromCurrency as string}→${r.toCurrency as string}`;

describe("ChainlinkFxSyncService.sync", () => {
  it("writes a row per listed token pair: stamped, tagged chainlink, markup carried", async () => {
    const { svc, created, cache, prisma } = harness({ currentMarkup: "1.5" });
    const summary = await svc.sync(NOW);

    expect(summary.feedErrors).toEqual([]);
    expect(created.map(label)).toEqual([
      "ETH→USD",
      "EURC→USD",
      "EURC→IDR",
      "USDC→USD",
      "USDC→IDR",
    ]);
    const idr = created.find((r) => label(r) === "USDC→IDR")!;
    expect(idr).toMatchObject({
      rate: "18238.88761174",
      region: "ID",
      provider: "chainlink",
      markup: "1.5",
      isActive: true,
      sourceProviderId: "src_chainlink",
    });
    expect((idr.createdAt as Date).getTime() % 60_000).toBe(0);
    expect(cache.invalidateRate).toHaveBeenCalledWith("USDC", "IDR");
    expect(prisma.exchangeSource.update).toHaveBeenCalled();
    // Healthy primaries: no fallback feed is read.
    expect(svc.reads.sort()).toEqual(Object.keys(FRESH).sort());
  });

  it("falls back to the next chain when the Arc feed fails", async () => {
    const { svc, created } = harness({
      tokens: [{ symbol: "USDC", isStablecoin: true }],
      feeds: {
        "arc:USDC/USD": raw("USDC", 99_967_343n, 3 * 86_400), // stale
        "base:USDC/USD": raw("USDC", 100_010_000n),
        "base:IDR/USD": raw("IDR", 5481n, 100),
      },
    });
    const summary = await svc.sync(NOW);
    expect(summary.feedsUsed).toEqual({
      USDC: "base:USDC/USD",
      IDR: "base:IDR/USD",
    });
    expect(summary.feedErrors.map((e) => e.key)).toEqual(["arc:USDC/USD"]);
    expect(created.find((r) => label(r) === "USDC→USD")?.rate).toBe("1.0001");
  });

  it("writes nothing for a pair when every feed for it fails", async () => {
    const { svc, created } = harness({
      tokens: [{ symbol: "USDC", isStablecoin: true }],
      feeds: { "arc:USDC/USD": raw("USDC", 99_967_343n) }, // both IDR feeds down
    });
    const summary = await svc.sync(NOW);
    expect(created.map(label)).toEqual(["USDC→USD"]);
    expect(summary.pairs.find((p) => p.pair === "USDC/IDR@ID")?.status).toBe(
      "skipped",
    );
  });

  it("does not write when Chainlink has no new value since the last row", async () => {
    const { svc, created } = harness({
      lastChainlinkCreatedAt: new Date(NOW_SEC * 1000 - 60_000),
    });
    const summary = await svc.sync(NOW);
    expect(created).toHaveLength(0);
    expect(summary.pairs.every((p) => p.status === "unchanged")).toBe(true);
  });

  it("writes nothing when the Chainlink source is switched off", async () => {
    const { svc, created, prisma } = harness({ sourceActive: false });
    expect((await svc.sync(NOW)).sourceActive).toBe(false);
    expect(created).toHaveLength(0);
    expect(prisma.token.findMany).not.toHaveBeenCalled();
  });

  it("treats a unique-key collision as another instance's write", async () => {
    const { svc } = harness({
      createError: new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    });
    const summary = await svc.sync(NOW);
    expect(summary.pairs.every((p) => p.status === "unchanged")).toBe(true);
  });
});
