import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { http, createPublicClient, parseAbi, type PublicClient } from "viem";
import { Prisma } from "@generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { ExchangeRateCacheService } from "../../valkey/services/exchange-rate-cache.service";
import { resolveRpcEndpoint } from "../../blockchains/rpc-endpoint";
import {
  CHAINLINK_FX_FEEDS,
  CHAINLINK_PROVIDER,
  CHAINLINK_SOURCE_NAME,
  type ChainlinkFxFeedPin,
} from "./chainlink-feeds";
import {
  checkFeedRead,
  computePairRate,
  derivePairs,
  hasNewRound,
  type FeedReading,
  type FxPair,
  type RawFeedRead,
} from "./chainlink-fx";

const AGGREGATOR_ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type PairOutcome =
  | { pair: string; status: "written"; rate: string; id: number }
  | { pair: string; status: "unchanged" | "skipped"; reason: string };

export interface SyncSummary {
  sourceActive: boolean;
  /** Feed actually used per asset (first clean read in pin order). */
  feedsUsed: Record<string, string>;
  /** Every failed read, including ones a fallback feed covered. */
  feedErrors: { key: string; reason: string }[];
  pairs: PairOutcome[];
}

function pairLabel(pair: FxPair): string {
  return `${pair.fromCurrency}/${pair.toCurrency}${pair.region ? `@${pair.region}` : ""}`;
}

/**
 * Writes Chainlink prices into `ExchangeRate` as history: one row per new
 * Chainlink value per pair, under the "Chainlink" `ExchangeSource`. Which
 * tokens get prices comes from the active `Token` rows (see `derivePairs`).
 *
 * The newest active row for a pair is what prices payments, so a manual
 * dashboard row stays in force until Chainlink posts its next value (hourly
 * for IDR/USD on Base). Set the "Chainlink" source inactive to stop writes.
 *
 * Anything doubtful (wrong feed, stale, depegged, RPC down) writes nothing:
 * the previous row keeps pricing, and the reason goes to the server log.
 */
@Injectable()
export class ChainlinkFxSyncService {
  private readonly logger = new Logger(ChainlinkFxSyncService.name);
  private running = false;
  private readonly clients = new Map<
    number,
    { rpcUrl: string; client: PublicClient }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRateCache: ExchangeRateCacheService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledSync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.sync();
      for (const e of summary.feedErrors) {
        this.logger.warn(`feed ${e.key} not used: ${e.reason}`);
      }
      this.logger.debug(`feeds used: ${JSON.stringify(summary.feedsUsed)}`);
      for (const p of summary.pairs) {
        if (p.status === "written") {
          this.logger.log(`${p.pair} = ${p.rate} (row ${p.id})`);
        } else if (p.status === "skipped") {
          this.logger.warn(`${p.pair} not written: ${p.reason}`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Chainlink FX sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async sync(now: Date = new Date()): Promise<SyncSummary> {
    const source = await this.prisma.exchangeSource.upsert({
      where: { name: CHAINLINK_SOURCE_NAME },
      create: {
        name: CHAINLINK_SOURCE_NAME,
        description:
          "Chainlink on-chain price feeds (Arc for stablecoins, Base for IDR/USD)",
        updateInterval: 600,
        priority: 1,
        isActive: true,
      },
      update: {},
    });
    if (!source.isActive) {
      return { sourceActive: false, feedsUsed: {}, feedErrors: [], pairs: [] };
    }

    const tokens = await this.prisma.token.findMany({
      where: { isActive: true },
      select: { symbol: true, isStablecoin: true },
    });
    const wanted = derivePairs(tokens);

    // Floored to the minute so two api instances racing the same round
    // collide on the (pair, region, provider, createdAt) unique key.
    const stampedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const nowSec = Math.floor(now.getTime() / 1000);

    const { readings, errors, used } = await this.readFeeds(wanted, nowSec);
    const pairs: PairOutcome[] = [];
    let wrote = false;

    for (const pair of wanted) {
      const label = pairLabel(pair);
      const computed = computePairRate(pair, readings);
      if (!computed.ok) {
        pairs.push({ pair: label, status: "skipped", reason: computed.reason });
        continue;
      }

      const last = await this.prisma.exchangeRate.findFirst({
        where: {
          fromCurrency: pair.fromCurrency,
          toCurrency: pair.toCurrency,
          region: pair.region,
          provider: CHAINLINK_PROVIDER,
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!hasNewRound(computed.inputsUpdatedAtSec, last?.createdAt ?? null)) {
        pairs.push({
          pair: label,
          status: "unchanged",
          reason: "no new Chainlink value since last row",
        });
        continue;
      }

      // Markup is business config, not a price: carry the pair's current
      // markup forward so a dashboard-set markup survives every new row.
      const current = await this.prisma.exchangeRate.findFirst({
        where: {
          fromCurrency: pair.fromCurrency,
          toCurrency: pair.toCurrency,
          region: pair.region,
          isActive: true,
        },
        orderBy: { createdAt: "desc" },
        select: { markup: true },
      });

      try {
        const row = await this.prisma.exchangeRate.create({
          data: {
            fromCurrency: pair.fromCurrency,
            toCurrency: pair.toCurrency,
            rate: computed.rate,
            region: pair.region,
            provider: CHAINLINK_PROVIDER,
            markup: current?.markup ?? null,
            isActive: true,
            sourceProviderId: source.id,
            createdAt: stampedAt,
          },
          select: { id: true },
        });
        wrote = true;
        pairs.push({
          pair: label,
          status: "written",
          rate: computed.rate,
          id: row.id,
        });
        await this.exchangeRateCache.invalidateRate(
          pair.fromCurrency,
          pair.toCurrency,
        );
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          pairs.push({
            pair: label,
            status: "unchanged",
            reason: "another instance wrote this round",
          });
          continue;
        }
        throw err;
      }
    }

    if (wrote) {
      await this.prisma.exchangeSource.update({
        where: { id: source.id },
        data: { lastUpdated: now },
      });
    }

    return { sourceActive: true, feedsUsed: used, feedErrors: errors, pairs };
  }

  /**
   * One clean reading per needed asset. Assets are read in parallel; within
   * an asset, feeds are tried in pin order and later ones are only read when
   * earlier ones fail, so fallbacks cost nothing while Arc is healthy.
   */
  private async readFeeds(
    pairs: readonly FxPair[],
    nowSec: number,
  ): Promise<{
    readings: Map<string, FeedReading>;
    errors: { key: string; reason: string }[];
    used: Record<string, string>;
  }> {
    const assets = new Set(
      pairs.flatMap((p) =>
        p.quoteAsset ? [p.asset, p.quoteAsset] : [p.asset],
      ),
    );
    const readings = new Map<string, FeedReading>();
    const errors: { key: string; reason: string }[] = [];
    const used: Record<string, string> = {};

    await Promise.all(
      [...assets].map(async (asset) => {
        for (const pin of CHAINLINK_FX_FEEDS.filter((f) => f.asset === asset)) {
          let check;
          try {
            check = checkFeedRead(pin, await this.readFeedRaw(pin), nowSec);
          } catch (err) {
            check = {
              ok: false as const,
              key: pin.key,
              reason: `read failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
            };
          }
          if (check.ok) {
            readings.set(asset, check.reading);
            used[asset] = pin.key;
            return;
          }
          errors.push({ key: check.key, reason: check.reason });
        }
      }),
    );
    return { readings, errors, used };
  }

  /** One on-chain read of a pinned feed. Overridden in tests. */
  protected async readFeedRaw(pin: ChainlinkFxFeedPin): Promise<RawFeedRead> {
    const client = await this.clientFor(pin.chainId);
    const [description, decimals, round] = await Promise.all([
      client.readContract({
        address: pin.address,
        abi: AGGREGATOR_ABI,
        functionName: "description",
      }),
      client.readContract({
        address: pin.address,
        abi: AGGREGATOR_ABI,
        functionName: "decimals",
      }),
      client.readContract({
        address: pin.address,
        abi: AGGREGATOR_ABI,
        functionName: "latestRoundData",
      }),
    ]);
    return {
      description,
      decimals: Number(decimals),
      answer: round[1],
      updatedAtSec: round[3],
    };
  }

  /** RPC comes from the chain's `Blockchain` row (normally an rpc-proxy route). */
  private async clientFor(chainId: number): Promise<PublicClient> {
    const row = await this.prisma.blockchain.findUnique({
      where: { chainId },
      select: { rpcUrl: true },
    });
    if (!row) throw new Error(`no Blockchain row for chainId ${chainId}`);

    const cached = this.clients.get(chainId);
    if (cached && cached.rpcUrl === row.rpcUrl) return cached.client;

    const endpoint = resolveRpcEndpoint(row.rpcUrl);
    const client = createPublicClient({
      transport: http(endpoint.url, {
        timeout: 15_000,
        retryCount: 1,
        fetchOptions: Object.keys(endpoint.headers).length
          ? { headers: endpoint.headers }
          : undefined,
      }),
    }) as PublicClient;
    this.clients.set(chainId, { rpcUrl: row.rpcUrl, client });
    return client;
  }
}
