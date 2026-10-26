import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { erc20Abi, parseAbi } from "viem";
import { PrismaService } from "../prisma/prisma.service";
import { ValkeyService } from "../valkey/valkey.service";
import { CreateStrategyDto } from "./dto/create-strategy.dto";
import { UpdateStrategyDto } from "./dto/update-strategy.dto";
import { DefiError } from "./errors/defi-error";
import {
  AlchemyPricesClient,
  alchemyNetworkForChainId,
} from "./external/alchemy-prices.client";
import { LifiClient, LifiQuote } from "./external/lifi.client";
import {
  CHAIN_ID_BY_ZERION_ID,
  ZerionClient,
  type ZerionPosition,
} from "../external/zerion";
import { COMET_MARKETS, cometMarkets } from "./targets/address-book";
import { OPP_ROW_CACHE_TTL_SEC, oppRowCacheKey } from "./targets/cache-keys";
import { findChainById } from "./targets/chain-directory";
import { canonicalizeWalletAddress } from "../utils/address";
import { getPublicClientForChain } from "./targets/rpc";

/** Minimal Comet reads needed for discovery — balance + underlying identity. */
const COMET_DISCOVERY_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function baseToken() view returns (address)",
]);

/**
 * Risk tiers, safest first. Order is the whole point: a user's tier is the
 * HIGHEST risk they accept, so everything at or below it is eligible.
 */
const TIER_LADDER: readonly string[] = [
  "conservative",
  "balanced",
  "aggressive",
];

export interface AssetPriceQuery {
  chainId: number;
  assetSymbol: string;
  /** Omit for the chain's native coin — priced by symbol instead. */
  assetContract?: string;
}

export interface AssetPriceResult extends AssetPriceQuery {
  usd: number | null;
}

interface OpportunityFilter {
  tier?: string;
  assetSymbol?: string;
  chainId?: number;
  /** Chain-namespace filter ("eip155" | "solana" | "sui"). Non-EVM rows
   *  are chainId 0, so the namespace is how callers surface Sui/Solana
   *  yield without it colliding with EVM chainId 0. */
  namespace?: string;
  liquidityProfile?: string;
  amountUsd?: number;
}

@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifiClient: LifiClient,
    private readonly valkey: ValkeyService,
    private readonly alchemyPrices: AlchemyPricesClient,
    private readonly zerionClient: ZerionClient,
  ) {}

  /**
   * Batch USD spot price lookup for DeFi position valuation. Routes each
   * query to Alchemy's by-address endpoint (has a contract) or by-symbol
   * (native coin, no contract) — the only place either Alchemy Prices
   * endpoint is called from; the mobile client never talks to Alchemy
   * directly (same posture as the RPC provider key in `rpc-endpoint.ts`).
   * A chain with no Alchemy network mapping, or an asset Alchemy can't
   * price, resolves to `usd: null` — never thrown, so a partial-price batch
   * doesn't fail the whole request.
   */
  async getAssetPrices(
    queries: AssetPriceQuery[],
  ): Promise<AssetPriceResult[]> {
    const byAddress: { network: string; address: string }[] = [];
    const bySymbol = new Set<string>();
    for (const q of queries) {
      if (q.assetContract && alchemyNetworkForChainId(q.chainId)) {
        byAddress.push({
          network: alchemyNetworkForChainId(q.chainId) as string,
          address: q.assetContract,
        });
      } else {
        bySymbol.add(q.assetSymbol);
      }
    }

    const [addressPrices, symbolPrices] = await Promise.all([
      this.alchemyPrices.getPricesByAddress(byAddress),
      this.alchemyPrices.getPricesBySymbol([...bySymbol]),
    ]);

    return queries.map((q) => {
      const network = alchemyNetworkForChainId(q.chainId);
      const usd =
        q.assetContract && network
          ? (addressPrices.get(`${network}:${q.assetContract.toLowerCase()}`) ??
            null)
          : (symbolPrices.get(q.assetSymbol.toUpperCase()) ?? null);
      return { ...q, usd };
    });
  }

  quoteCrossChain(
    walletAddress: string,
    input: {
      fromChainId: number;
      toChainId: number;
      fromTokenContract: string;
      toTokenContract: string;
      amountRaw: string;
      toAddress?: string;
    },
  ): Promise<LifiQuote> {
    if (input.fromChainId === input.toChainId) {
      throw new DefiError(
        "unsupported_chain",
        "cross-chain quote requested with identical from/to chain",
      );
    }
    const fromAddress = walletAddress.toLowerCase();
    const toAddress = (input.toAddress ?? walletAddress).toLowerCase();
    return this.lifiClient.getRoute(
      input.fromChainId,
      input.toChainId,
      input.fromTokenContract.toLowerCase(),
      input.toTokenContract.toLowerCase(),
      input.amountRaw,
      fromAddress,
      toAddress,
    );
  }

  getCrossChainStatus(input: {
    fromChainId: number;
    toChainId: number;
    txHash: string;
  }): Promise<{ status: string; substatus?: string }> {
    return this.lifiClient.getStatus(
      input.fromChainId,
      input.toChainId,
      input.txHash,
    );
  }

  async getStrategy(walletAddress: string) {
    const strategy = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
      include: {
        positions: {
          where: { status: "active" },
        },
      },
    });

    if (!strategy) {
      throw new DefiError(
        "strategy_not_configured",
        `No strategy found for wallet ${walletAddress}`,
      );
    }

    return strategy;
  }

  async createStrategy(
    userId: string,
    walletAddress: string,
    dto: CreateStrategyDto,
  ) {
    const existing = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
    });

    if (existing) {
      throw new DefiError(
        "strategy_paused",
        "Strategy already exists for this wallet",
      );
    }

    const strategy = await this.prisma.userStrategy.create({
      data: {
        userId,
        walletAddress: canonicalizeWalletAddress(walletAddress),
        namespace: dto.namespace,
        tier: dto.tier,
        assetPreferences: dto.assetPreferences,
        liquidityPref: dto.liquidityPref,
        chainPref: dto.chainPref,
        allocationPct: dto.allocationPct,
        rebalanceTrigger: dto.rebalanceTrigger,
        protocolWhitelist: dto.protocolWhitelist || [],
        allowAllInTier: dto.allowAllInTier ?? false,
        autoCompound: dto.autoCompound ?? false,
        notificationLevel: dto.notificationLevel,
        activatedAt: new Date(),
      },
    });

    return strategy;
  }

  async updateStrategy(walletAddress: string, dto: UpdateStrategyDto) {
    const strategy = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
    });

    if (!strategy) {
      throw new DefiError(
        "strategy_not_configured",
        `No strategy found for wallet ${walletAddress}`,
      );
    }

    return await this.prisma.userStrategy.update({
      where: { id: strategy.id },
      data: {
        ...dto,
      },
    });
  }

  async deleteStrategy(walletAddress: string) {
    const strategy = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
    });

    if (!strategy) {
      throw new DefiError(
        "strategy_not_configured",
        `No strategy found for wallet ${walletAddress}`,
      );
    }

    return await this.prisma.userStrategy.delete({
      where: { id: strategy.id },
    });
  }

  /**
   * Return scored DeFi opportunities, optionally filtered by transient
   * params from the agent (`tier`, `asset_symbol`, `chain_id`,
   * `liquidity_profile`, `amount_usd`). When the caller has a saved
   * `UserStrategy`, the row's tier wins over the query tier so the
   * agent can't accidentally pull aggressive options for a conservative
   * user.
   *
   * Source of truth: `OpportunityCache`, populated by the
   * `defillama-poll` worker. Empty result = no opportunities; callers
   * render an empty state. No client-side or server-side fallback to
   * hardcoded data — production never serves seed/mock rows.
   */
  async getOpportunities(
    walletAddress: string,
    filter: OpportunityFilter = {},
  ) {
    this.logger.log(
      `[getOpportunities] wallet=${walletAddress} filter=${JSON.stringify(filter)}`,
    );

    const strategy = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
    });

    const effectiveTier = strategy?.tier ?? filter.tier;
    if (strategy?.tier && filter.tier && strategy.tier !== filter.tier) {
      this.logger.log(
        `[getOpportunities] tier override: query="${filter.tier}" -> strategy="${strategy.tier}"`,
      );
    }

    // Risk tier is a CEILING, not an equality test.
    //
    // This used to be `where.tier = effectiveTier`, which excluded anything
    // SAFER than the user asked for. An aggressive profile was therefore
    // shown zero USDT options on Arbitrum while two `balanced` USDT pools
    // sat in the cache — the user was blocked from lower-risk venues, which
    // protects nobody. The rule the rest of the system states is "never
    // propose protocols ABOVE the user's risk tier"; below is always fine.
    const ceilingIndex = effectiveTier
      ? TIER_LADDER.indexOf(effectiveTier)
      : -1;
    // An unrecognised tier string must not silently widen to "everything";
    // fall back to the exact value so a typo narrows rather than opens up.
    const allowedTiers =
      ceilingIndex >= 0
        ? TIER_LADDER.slice(0, ceilingIndex + 1)
        : effectiveTier
          ? [effectiveTier]
          : [];

    // Never show a pool whose numbers we have not refreshed recently. Rows
    // are re-scored every poll; one this old has dropped out of DeFiLlama's
    // feed or stopped scoring, and its APY/TVL describe the past.
    const where: Record<string, unknown> = {
      scoredAt: { gte: new Date(Date.now() - opportunityMaxAgeMs()) },
    };
    if (allowedTiers.length > 0) where.tier = { in: allowedTiers };
    if (filter.assetSymbol) where.assetSymbol = filter.assetSymbol;
    if (filter.chainId !== undefined) where.chainId = filter.chainId;
    if (filter.namespace) where.namespace = filter.namespace;

    const opportunities = await this.prisma.opportunityCache.findMany({
      where,
      orderBy: { score: "desc" },
    });
    this.logger.log(
      `[getOpportunities] OpportunityCache returned ${opportunities.length} rows for where=${JSON.stringify(where)}`,
    );
    if (opportunities.length > 0 || !effectiveTier) {
      return this.attachAppUrls(
        opportunities.map((o) => ({ ...o, outsideTier: false })),
      );
    }

    // Empty ONLY because of the risk-tier ceiling.
    //
    // A saved `UserStrategy.tier` outranks whatever the caller asked for
    // (see `effectiveTier` above), and that is correct — it is the ceiling
    // behind "never propose protocols above the user's risk tier". What is
    // NOT acceptable is the client then telling the user "there are no USDT
    // options on Arbitrum", which is false: there were two, both `balanced`,
    // and the user's profile was `conservative`. Silence turned a policy
    // into a lie, and left the user with no way forward.
    //
    // So: re-run without the tier and hand the rows back TAGGED. The client
    // must not auto-allocate into them — mobile's `allocatableRows` drops
    // them — but it can finally say what is true and let the user decide.
    const { tier: _tierCeiling, ...withoutTier } = where;
    const outside = await this.prisma.opportunityCache.findMany({
      where: withoutTier,
      orderBy: { score: "desc" },
      take: 25,
    });
    if (outside.length > 0) {
      this.logger.log(
        `[getOpportunities] tier="${effectiveTier}" matched nothing; ${outside.length} rows exist at other tiers — returning them tagged outsideTier`,
      );
    }
    return this.attachAppUrls(
      outside.map((o) => ({ ...o, outsideTier: true })),
    );
  }

  /**
   * Merge each pool's protocol-level `appUrl` (the manual deep-link homepage —
   * DeFiLlama's `/protocol/{slug}.url`, pool-level deposits spec §9.1) from
   * `ProtocolScoreCache`. It's protocol-scoped, so we fetch once per distinct
   * slug and fan it out onto the pool rows — the mobile "Manual" badge opens
   * this real protocol URL instead of falling back to the DeFiLlama page.
   */
  private async attachAppUrls<T extends { protocolSlug: string }>(
    rows: T[],
  ): Promise<Array<T & { appUrl: string | null }>> {
    if (rows.length === 0) return [];
    const slugs = [...new Set(rows.map((r) => r.protocolSlug))];
    const scores = await this.prisma.protocolScoreCache
      .findMany({
        where: { protocolSlug: { in: slugs } },
        select: { protocolSlug: true, appUrl: true },
      })
      .catch(() => [] as { protocolSlug: string; appUrl: string | null }[]);
    const bySlug = new Map(scores.map((s) => [s.protocolSlug, s.appUrl]));
    return rows.map((r) => ({
      ...r,
      appUrl: bySlug.get(r.protocolSlug) ?? null,
    }));
  }

  async getOpportunity(slug: string) {
    const opportunity = await this.prisma.opportunityCache.findFirst({
      where: {
        protocolSlug: slug,
      },
    });

    if (!opportunity) {
      throw new DefiError("protocol_not_found", slug);
    }

    return opportunity;
  }

  /**
   * Fetch a single OpportunityCache row by its DeFiLlama poolId — the
   * authoritative source the mobile executor re-fetches at deposit time to
   * read the server-resolved `depositTarget` (spec §6; the LLM only ever
   * passes `pool_id`, never an address). Keyed by poolId (`@@unique`), so it
   * pins the exact sibling pool, unlike `getOpportunity(slug)` which keys by
   * protocolSlug and returns the first pool for the protocol.
   *
   * Valkey-cached (spec §11 Q4) with a short TTL; the score worker invalidates
   * the key on upsert so a freshly-resolved target is picked up on the next read.
   */
  async getPoolById(poolId: string) {
    const cacheKey = oppRowCacheKey(poolId);
    const cached = await this.valkey.get(cacheKey).catch(() => null);
    if (cached) return cached;

    const opportunity = await this.prisma.opportunityCache.findUnique({
      where: { poolId },
    });
    if (!opportunity) {
      throw new DefiError("protocol_not_found", poolId);
    }

    const [withAppUrl] = await this.attachAppUrls([opportunity]);
    await this.valkey
      .set(cacheKey, withAppUrl, { ttl: OPP_ROW_CACHE_TTL_SEC })
      .catch(() => undefined);
    return withAppUrl;
  }

  /**
   * Returns the protocol allowlist for a given tier — the canonical
   * set the user can pick from when narrowing their `protocolWhitelist`
   * in `/strategies/settings` (spec §21.2). Read exclusively from
   * `OpportunityCache` (the live, scored set kept fresh by the
   * `defillama-poll` worker). Empty result = nothing curated for this
   * tier yet; clients render an empty state.
   *
   * Deduplicated by `protocolSlug` — each cached pool can appear
   * multiple times across assets, but the whitelist key is the slug,
   * so the picker only needs one row per slug. `chainName` is the
   * DefiLlama-provided label stored on the row at poll time (works
   * uniformly for EVM, Solana, and Sui).
   */
  async getProtocols(tier?: string) {
    const where: Record<string, unknown> = {};
    if (tier) where.tier = tier;

    const source = await this.prisma.opportunityCache.findMany({
      where,
      orderBy: { score: "desc" },
    });

    const seen = new Map<
      string,
      {
        protocolSlug: string;
        namespace: string;
        chainId: number;
        chainName: string;
        tier: string;
        assetSymbol: string;
      }
    >();
    for (const o of source) {
      if (seen.has(o.protocolSlug)) continue;
      seen.set(o.protocolSlug, {
        protocolSlug: o.protocolSlug,
        namespace: o.namespace,
        chainId: o.chainId,
        chainName: o.chainName,
        tier: o.tier,
        assetSymbol: o.assetSymbol,
      });
    }
    return Array.from(seen.values());
  }

  async getPositions(userId: string, walletAddress: string) {
    const positions = await this.prisma.strategyPosition.findMany({
      where: {
        walletAddress: walletAddress.toLowerCase(),
      },
      orderBy: {
        openedAt: "desc",
      },
    });
    const reconciled = await this.reconcilePositions(
      userId,
      walletAddress,
      positions,
    ).catch((err) => {
      this.logger.error(
        `[getPositions] reconciliation failed (best-effort, showing DB rows only) for wallet=${walletAddress}: ${(err as Error).message}`,
      );
      return positions;
    });
    return this.attachCurrentApy(reconciled);
  }

  /**
   * Discovers DeFi positions the wallet actually holds on-chain but that
   * have no `StrategyPosition` row — e.g. a signed, successful deposit
   * whose `createPosition` call failed (the `strategy_not_configured` bug
   * `ensureUserStrategy` now fixes going forward), or a position opened
   * outside this app entirely. Two sources, run best-effort in sequence so
   * the second sees rows the first just backfilled and never double-writes:
   *
   *   1. Our own address-book (`COMET_MARKETS`) — a direct on-chain
   *      `balanceOf` scan. Reliable for Compound III specifically because
   *      the receipt token *is* the market contract, and we already have
   *      every known Comet pinned for validation. Verified against a live
   *      wallet 2026-08-16 — Zerion classified that wallet's `cUSDTv3`
   *      balance as a plain `"wallet"`-type token, NOT a `"deposit"`
   *      position (no protocol tag, no value), so it would NOT have been
   *      caught by source 2 alone.
   *   2. Zerion's wallet-positions API — broader coverage (any protocol
   *      Zerion itself classifies as `"deposit"`/`"staked"`) but, per the
   *      above, demonstrably incomplete for at least this one real case.
   *      Best-effort discovery layer per the original spec (§9.2), not an
   *      authoritative source — never used for the trade-decision path.
   *
   * A discovered row is persisted with today's on-chain balance/value as
   * its `amountAtDeposit(Usd)` baseline (we cannot know the real historical
   * deposit — PnL starts at 0% rather than showing a fabricated gain/loss)
   * and `openedAt` = discovery time, not the real deposit time.
   */
  private async reconcilePositions(
    userId: string,
    walletAddress: string,
    positions: Awaited<ReturnType<StrategiesService["getPositionsRaw"]>>,
  ) {
    let all = positions;
    const cometBackfilled = await this.discoverCometPositions(
      userId,
      walletAddress,
      all,
    );
    if (cometBackfilled.length > 0) all = [...cometBackfilled, ...all];

    const zerionBackfilled = await this.discoverZerionPositions(
      userId,
      walletAddress,
      all,
    );
    if (zerionBackfilled.length > 0) all = [...zerionBackfilled, ...all];

    return all;
  }

  /** Typed only so `reconcilePositions` can reference `getPositions`'s row shape. */
  private getPositionsRaw() {
    return this.prisma.strategyPosition.findMany();
  }

  private async discoverCometPositions(
    userId: string,
    walletAddress: string,
    existing: {
      protocolSlug: string;
      chainId: number;
      assetContract: string | null;
      status: string;
    }[],
  ) {
    const known = new Set(
      existing
        .filter(
          (p) => p.protocolSlug === "compound-v3" && p.status === "active",
        )
        .map((p) => `${p.chainId}:${(p.assetContract ?? "").toLowerCase()}`),
    );
    const created: NonNullable<
      Awaited<ReturnType<StrategiesService["createPosition"]>>
    >[] = [];

    for (const chainIdStr of Object.keys(COMET_MARKETS)) {
      const chainId = Number(chainIdStr);
      const client = getPublicClientForChain(chainId);
      if (!client) continue;

      for (const comet of cometMarkets(chainId)) {
        try {
          const balance = await client.readContract({
            address: comet,
            abi: COMET_DISCOVERY_ABI,
            functionName: "balanceOf",
            args: [walletAddress as `0x${string}`],
          });
          if (balance <= 0n) continue;

          const baseToken = await client.readContract({
            address: comet,
            abi: COMET_DISCOVERY_ABI,
            functionName: "baseToken",
          });
          const key = `${chainId}:${baseToken.toLowerCase()}`;
          if (known.has(key)) continue;
          known.add(key); // dedupe within this scan too

          const opp = await this.prisma.opportunityCache
            .findFirst({
              where: {
                protocolSlug: "compound-v3",
                chainId,
                depositTarget: { path: ["comet"], equals: comet },
              },
              select: {
                poolId: true,
                assetSymbol: true,
                chainName: true,
                tier: true,
              },
            })
            .catch(() => null);

          let assetSymbol = opp?.assetSymbol;
          if (!assetSymbol) {
            assetSymbol = await client
              .readContract({
                address: baseToken,
                abi: erc20Abi,
                functionName: "symbol",
              })
              .catch(() => "");
          }
          const decimals = await client
            .readContract({
              address: baseToken,
              abi: erc20Abi,
              functionName: "decimals",
            })
            .catch(() => 18);

          const position = await this.createDiscoveredPosition(
            userId,
            walletAddress,
            {
              protocolSlug: "compound-v3",
              chainId,
              namespace: "eip155",
              assetSymbol,
              assetContract: baseToken,
              poolId: opp?.poolId,
              amountRaw: balance.toString(),
              decimals,
              tier: opp?.tier,
              chainName: opp?.chainName ?? findChainById(chainId)?.name ?? "",
            },
          );
          if (position) created.push(position);
        } catch (err) {
          this.logger.warn(
            `[discoverCometPositions] scan failed for comet=${comet} chain=${chainId}: ${(err as Error).message}`,
          );
        }
      }
    }
    return created;
  }

  private async discoverZerionPositions(
    userId: string,
    walletAddress: string,
    existing: {
      protocolSlug: string;
      chainId: number;
      assetContract: string | null;
      status: string;
    }[],
  ) {
    const known = new Set(
      existing
        .filter((p) => p.status === "active")
        .map((p) => `${p.chainId}:${(p.assetContract ?? "").toLowerCase()}`),
    );

    let zerionPositions: ZerionPosition[] = [];
    try {
      zerionPositions = await this.zerionClient.getPositions(walletAddress);
    } catch (err) {
      this.logger.warn(
        `[discoverZerionPositions] Zerion lookup failed (best-effort): ${(err as Error).message}`,
      );
      return [];
    }

    const created: NonNullable<
      Awaited<ReturnType<StrategiesService["createPosition"]>>
    >[] = [];
    for (const zp of zerionPositions) {
      // A dust-value or unpriced row isn't worth adopting as a tracked
      // position — Zerion's own numbers are display-only anyway.
      if (zp.valueUsd === null || zp.valueUsd < 1) continue;
      const chainId = CHAIN_ID_BY_ZERION_ID[zp.zerionChainId];
      if (!chainId) continue; // chain we don't support for DeFi yet

      const key = `${chainId}:${(zp.assetContract ?? "").toLowerCase()}`;
      if (known.has(key)) continue;
      known.add(key);

      // Best-effort protocolSlug: prefer an OpportunityCache row whose
      // family loosely matches Zerion's dapp id, so a real APY join is
      // possible later. Fall back to a clearly Zerion-sourced pseudo-slug
      // (never something that would resolve through our own adapter
      // registry for execution) when no confident match exists.
      const opp = zp.dappId
        ? await this.prisma.opportunityCache
            .findFirst({
              where: {
                chainId,
                assetSymbol: zp.assetSymbol,
                protocolSlug: { contains: zp.dappId.split("-")[0] },
              },
              select: {
                poolId: true,
                protocolSlug: true,
                chainName: true,
                tier: true,
              },
            })
            .catch(() => null)
        : null;

      const position = await this.createDiscoveredPosition(
        userId,
        walletAddress,
        {
          protocolSlug: opp?.protocolSlug ?? `zerion:${zp.dappId ?? "unknown"}`,
          chainId,
          namespace: "eip155",
          assetSymbol: zp.assetSymbol,
          assetContract: zp.assetContract ?? undefined,
          poolId: opp?.poolId,
          amountRaw: zp.quantityRaw,
          decimals: zp.decimals,
          tier: opp?.tier,
          chainName: opp?.chainName ?? findChainById(chainId)?.name ?? "",
          // Zerion already computed USD — cheaper and no less accurate than
          // a second price lookup for a row we're only backfilling once.
          amountUsdOverride: zp.valueUsd,
        },
      );
      if (position) created.push(position);
    }
    return created;
  }

  private async createDiscoveredPosition(
    userId: string,
    walletAddress: string,
    input: {
      protocolSlug: string;
      chainId: number;
      namespace: string;
      assetSymbol: string;
      assetContract?: string;
      poolId?: string | null;
      amountRaw: string;
      decimals: number;
      tier?: string | null;
      chainName: string;
      amountUsdOverride?: number | null;
    },
  ) {
    try {
      const amountAtDepositUsd =
        input.amountUsdOverride ??
        (
          await this.getAssetPrices([
            {
              chainId: input.chainId,
              assetSymbol: input.assetSymbol,
              assetContract: input.assetContract,
            },
          ])
        )[0]?.usd;
      const humanAmount = Number(input.amountRaw) / 10 ** input.decimals;
      const usd =
        amountAtDepositUsd != null && Number.isFinite(amountAtDepositUsd)
          ? humanAmount * amountAtDepositUsd
          : 0;

      const strategy = await this.ensureUserStrategy(
        userId,
        walletAddress,
        input.namespace,
        input.tier ?? "conservative",
      );

      this.logger.log(
        `[createDiscoveredPosition] backfilling ${input.protocolSlug} chain=${input.chainId} asset=${input.assetSymbol} wallet=${walletAddress} (found on-chain, no prior StrategyPosition row)`,
      );

      return await this.prisma.strategyPosition.create({
        data: {
          userStrategy: { connect: { id: strategy.id } },
          walletAddress: walletAddress.toLowerCase(),
          protocolSlug: input.protocolSlug,
          chainId: input.chainId,
          namespace: input.namespace,
          chainName: input.chainName,
          assetSymbol: input.assetSymbol,
          assetContract: input.assetContract,
          poolId: input.poolId ?? undefined,
          amountAtDeposit: input.amountRaw,
          amountAtDepositUsd: usd,
          currentAmountRaw: input.amountRaw,
          currentAmountUsd: usd,
          status: "active",
          openedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(
        `[createDiscoveredPosition] failed to persist discovered position (${input.protocolSlug}, wallet=${walletAddress}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  async getPosition(id: string, walletAddress: string) {
    const position = await this.prisma.strategyPosition.findFirst({
      where: {
        id,
        walletAddress: walletAddress.toLowerCase(),
      },
    });

    if (!position) {
      throw new DefiError("position_not_found", id);
    }

    const [enriched] = await this.attachCurrentApy([position]);
    return enriched;
  }

  /**
   * Join each position to its live `OpportunityCache` row to surface an
   * ongoing `currentApy` — computed at read time, never persisted (APY
   * drifts continuously, so there is nothing to snapshot). No screen
   * showed an earning rate on an *open* position before this; APY only
   * ever appeared pre-deposit on the Opportunities list.
   *
   * Prefers the exact pool via `poolId` (unique on `OpportunityCache`,
   * spec §4.2 — pins the exact sibling pool). Legacy positions opened
   * before pool-level routing have no `poolId`, so those fall back to
   * `(protocolSlug, chainId, namespace)` best-effort, same lookup
   * `createPosition` already does for `chainName` above.
   */
  private async attachCurrentApy<
    T extends {
      poolId: string | null;
      protocolSlug: string;
      chainId: number;
      namespace: string;
    },
  >(positions: T[]): Promise<(T & { currentApy: number | null })[]> {
    if (positions.length === 0) return [];

    const poolIds = [
      ...new Set(
        positions.map((p) => p.poolId).filter((id): id is string => !!id),
      ),
    ];
    const byPoolId =
      poolIds.length > 0
        ? await this.prisma.opportunityCache.findMany({
            where: { poolId: { in: poolIds } },
            select: { poolId: true, apy: true },
          })
        : [];
    const apyByPoolId = new Map(byPoolId.map((o) => [o.poolId, Number(o.apy)]));

    const legacy = positions.filter((p) => !p.poolId);
    const apyByLegacyKey = new Map<string, number>();
    if (legacy.length > 0) {
      const rows = await this.prisma.opportunityCache.findMany({
        where: {
          OR: legacy.map((p) => ({
            protocolSlug: p.protocolSlug,
            chainId: p.chainId,
            namespace: p.namespace,
          })),
        },
        select: {
          protocolSlug: true,
          chainId: true,
          namespace: true,
          apy: true,
        },
      });
      for (const row of rows) {
        const key = `${row.protocolSlug}:${row.chainId}:${row.namespace}`;
        if (!apyByLegacyKey.has(key)) apyByLegacyKey.set(key, Number(row.apy));
      }
    }

    return positions.map((p) => ({
      ...p,
      currentApy: p.poolId
        ? (apyByPoolId.get(p.poolId) ?? null)
        : (apyByLegacyKey.get(
            `${p.protocolSlug}:${p.chainId}:${p.namespace}`,
          ) ?? null),
    }));
  }

  /**
   * Find the wallet's `UserStrategy`, or create a minimal default one.
   *
   * `StrategyPosition.userStrategyId` is a required FK, so recording a
   * position has always needed a `UserStrategy` row to exist first —
   * previously enforced by throwing `strategy_not_configured` and dropping
   * the position write entirely. That silently lost every position for a
   * wallet that deposited via the agent without ever visiting the
   * `/strategies` onboarding screen (confirmed empty `StrategyPosition` +
   * `UserStrategy` tables in production despite real, signed on-chain
   * deposits — the write was failing on every single call).
   *
   * The auto-created default matches `fallbackTier` (the tier of the pool
   * actually being recorded) rather than an arbitrary tier — it describes
   * what the user already did, and grants no additional risk versus the
   * fully-open tier/whitelist bypass that ran when `strategy` was null
   * (see the deposit guard in `services/agent-executors/defi/writes.ts`).
   * `allowAllInTier: true` avoids immediately blocking a second deposit
   * into a protocol the user already used, in that same tier, via the
   * curated-whitelist default.
   */
  /**
   * The saved risk tier for a wallet, or `null` when the user has never
   * onboarded. Non-throwing twin of `getStrategy`.
   *
   * Public because `RecurringInvestService` needs it and must NOT reach the
   * `UserStrategy` table itself: how that table keys wallets (canonical, plus
   * legacy lowercased rows, see `strategyWalletWhere`) stays owned by the
   * module that owns the table.
   */
  async getSavedTier(walletAddress: string): Promise<string | null> {
    const strategy = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
      select: { tier: true },
    });
    return strategy?.tier ?? null;
  }

  /**
   * Find-or-create the wallet's `UserStrategy`.
   *
   * Public since DCA v1: creating a recurring plan calls it with the plan's
   * tier so plan and strategy agree from the start (quick-invest §12.6),
   * the same way the deposit path already lazily creates a row rather than
   * gating a first deposit behind onboarding.
   */
  async ensureUserStrategy(
    userId: string,
    walletAddress: string,
    namespace: string,
    fallbackTier: string,
  ) {
    const existing = await this.prisma.userStrategy.findFirst({
      where: strategyWalletWhere(walletAddress),
    });
    if (existing) return existing;

    const tier = ["conservative", "balanced", "aggressive"].includes(
      fallbackTier,
    )
      ? fallbackTier
      : "conservative";

    this.logger.warn(
      `[ensureUserStrategy] auto-creating default UserStrategy (tier=${tier}) for wallet=${walletAddress} — deposited without prior /strategies onboarding`,
    );

    return this.prisma.userStrategy.create({
      data: {
        userId,
        walletAddress: canonicalizeWalletAddress(walletAddress),
        namespace,
        tier,
        assetPreferences: ["stable"],
        liquidityPref: "instant",
        chainPref: ["any"],
        allocationPct: 25,
        rebalanceTrigger: { kind: "interval", value: "monthly" },
        protocolWhitelist: [],
        allowAllInTier: true,
        autoCompound: false,
        notificationLevel: "alerts",
        activatedAt: new Date(),
      },
    });
  }

  async createPosition(
    userId: string,
    walletAddress: string,
    dto: {
      protocolSlug: string;
      chainId: number;
      namespace: string;
      assetSymbol: string;
      assetContract?: string;
      poolId?: string;
      amountAtDeposit: string;
      amountAtDepositUsd: number;
      openTxHash?: string;
      goal?: string;
      targetDate?: Date;
      /**
       * ERC-7540 async vaults only (docs/defi-evm-protocol-expansion-spec.md
       * §7). A position opened by `buildRequestDeposit` is not yet a
       * settled deposit — it is a REQUEST, and `asyncPhase` is what makes
       * that durable: without it, the row is indistinguishable from a
       * normal position and `async-claim-watcher.processor.ts`'s own
       * `WHERE asyncPhase IN (...)` scan never finds it, so it is never
       * polled, never flips to claimable, and the user is never notified.
       * The mobile executor sets this from `adapter.buildRequestDeposit`
       * capability-detection, never from a client-asserted flag on an
       * ordinary sync deposit (§8.2 — only what the executor itself proved).
       */
      /**
       * Deliberately NOT imported from `async-claim-watcher.processor.ts`
       * (which owns the canonical `ASYNC_PHASE` map) — that file pulls in
       * `PushService` -> `expo-server-sdk`, an ESM package jest's transform
       * config does not cover, and importing it here broke every test that
       * imports this service. Two literals duplicated is cheaper than a
       * service file the whole app depends on failing to parse under test.
       */
      asyncPhase?: "deposit_requested" | "redeem_requested";
      /** The ERC-7540 requestId the request tx emitted, echoed back at claim. */
      asyncRequestId?: string;
      asyncRequestedRaw?: string;
    },
  ) {
    // The type above already restricts `asyncPhase` to the two "*_requested"
    // values at compile time; deposit_claimable/redeem_claimable only exist
    // after the watcher observes fulfilment, so a caller cannot even express
    // "already claimable" here — the constraint that used to be a runtime
    // check is a type constraint instead.
    // Inherit chainName + tier from the source OpportunityCache row
    // (DefiLlama-provided label + our own scoring). Works uniformly for
    // EVM (chainId match) and non-EVM (chainId=0 with namespace
    // discriminator). Looked up before `ensureUserStrategy` so an
    // auto-created default strategy can match the deposited pool's tier.
    const sourceOpp = await this.prisma.opportunityCache.findFirst({
      where: {
        protocolSlug: dto.protocolSlug,
        chainId: dto.chainId,
        namespace: dto.namespace,
      },
      select: { chainName: true, tier: true },
    });

    const strategy = await this.ensureUserStrategy(
      userId,
      walletAddress,
      dto.namespace,
      sourceOpp?.tier ?? "conservative",
    );

    const amountUsd =
      Number.isFinite(dto.amountAtDepositUsd) && dto.amountAtDepositUsd != null
        ? dto.amountAtDepositUsd
        : 0;

    try {
      return await this.prisma.strategyPosition.create({
        data: {
          userStrategy: { connect: { id: strategy.id } },
          walletAddress: walletAddress.toLowerCase(),
          protocolSlug: dto.protocolSlug,
          chainId: dto.chainId,
          namespace: dto.namespace,
          chainName: sourceOpp?.chainName ?? "",
          assetSymbol: dto.assetSymbol,
          assetContract: dto.assetContract,
          poolId: dto.poolId,
          amountAtDeposit: dto.amountAtDeposit,
          amountAtDepositUsd: amountUsd,
          status: "active",
          openTxHash: dto.openTxHash,
          openedAt: new Date(),
          goal: dto.goal,
          targetDate: dto.targetDate,
          asyncPhase: dto.asyncPhase,
          asyncRequestId: dto.asyncRequestId,
          asyncRequestedRaw: dto.asyncRequestedRaw,
          asyncRequestedAt: dto.asyncPhase ? new Date() : undefined,
        },
      });
    } catch (err) {
      this.logger.error(
        `[createPosition] prisma create failed for wallet=${walletAddress} slug=${dto.protocolSlug}: ${(err as Error).name}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Persist a freshly-observed on-chain value. On-chain reads live in
   * mobile (per-protocol viem adapters, `services/defi/positions/reader.ts`
   * — duplicating that per-`DepositTarget`-kind logic server-side isn't
   * worth it), so the mobile client is the trust anchor here: it computes
   * `current_amount_raw`/`current_amount_usd` live (on-chain read + Alchemy
   * spot price via `computePnl`) and PATCHes the result back so consumers
   * that don't do a live read themselves — `auto-compound-watcher`,
   * `goal-deadline-watcher`, push notifications — see a reasonably fresh
   * number instead of the permanently-null value this endpoint used to
   * leave behind (it was a no-op stub before this).
   *
   * Best-effort by design: called from the same try/catch-wrapped call site
   * as `createPosition` (`services/agent-executors/defi/*.ts`), so a failure
   * here never blocks the read the user is looking at.
   */
  async refreshPosition(
    id: string,
    walletAddress: string,
    observed?: { currentAmountRaw?: string; currentAmountUsd?: number },
  ) {
    const position = await this.getPosition(id, walletAddress);

    if (
      observed?.currentAmountRaw === undefined &&
      observed?.currentAmountUsd === undefined
    ) {
      return { ...position, refreshedAt: new Date() };
    }

    const updated = await this.prisma.strategyPosition.update({
      where: { id: position.id },
      data: {
        ...(observed.currentAmountRaw !== undefined
          ? { currentAmountRaw: observed.currentAmountRaw }
          : {}),
        ...(observed.currentAmountUsd !== undefined &&
        Number.isFinite(observed.currentAmountUsd)
          ? { currentAmountUsd: observed.currentAmountUsd }
          : {}),
      },
    });

    const [enriched] = await this.attachCurrentApy([updated]);
    return { ...enriched, refreshedAt: new Date() };
  }

  /**
   * ERC-7540 claim recorded — the position leaves the `*_requested`/
   * `*_claimable` state machine (§7). Called by the mobile executor after
   * `buildClaimDeposit`/`buildClaimRedeem` confirms on chain.
   *
   * `asyncPhase` clears to `null` rather than being set to some terminal
   * "claimed" value: once claimed, the position is an ordinary settled
   * position again — `deposit` claims land as a normal supply-side balance,
   * `redeem` claims mean the withdraw finished — and the async-specific
   * columns have done their job. `async-claim-watcher.processor.ts`'s scan
   * (`WHERE asyncPhase IN ('*_requested')`) already ignores `null`, so
   * clearing it is what actually removes the position from the watcher —
   * this endpoint is the other half of that contract, not just bookkeeping.
   */
  async claimAsyncPosition(
    id: string,
    walletAddress: string,
    claimTxHash: string,
  ) {
    const position = await this.getPosition(id, walletAddress);
    if (
      position.asyncPhase !== "deposit_claimable" &&
      position.asyncPhase !== "redeem_claimable"
    ) {
      throw new BadRequestException(
        `position ${id} is not in a claimable async phase (asyncPhase=${position.asyncPhase ?? "null"})`,
      );
    }

    const wasRedeem = position.asyncPhase === "redeem_claimable";
    const updated = await this.prisma.strategyPosition.update({
      where: { id: position.id },
      data: {
        asyncPhase: null,
        asyncTxHash: claimTxHash,
        // A claimed REDEEM is the position closing, mirroring how every
        // other family's withdraw sets status; a claimed DEPOSIT is not a
        // status change, it just stops being "pending".
        ...(wasRedeem ? { status: "withdrawn", closedAt: new Date() } : {}),
      },
    });

    const [enriched] = await this.attachCurrentApy([updated]);
    return { ...enriched, claimedAt: new Date() };
  }
}

/**
 * `UserStrategy` lookup by wallet. Rows are written canonical per encoding
 * (`canonicalizeWalletAddress`: EVM checksummed, Sui folded, Solana/Stellar
 * verbatim). Rows written before that were blanket-lowercased, which is
 * lossy for base58/base32, so the lowercase form is still matched: those rows
 * keep resolving with no backfill (prod runs `prisma db push`, which never
 * runs migration data).
 */
function strategyWalletWhere(walletAddress: string) {
  const canonical = canonicalizeWalletAddress(walletAddress);
  const legacy = walletAddress.trim().toLowerCase();
  return {
    walletAddress: {
      in: canonical === legacy ? [canonical] : [canonical, legacy],
    },
  };
}

/** How old a scored opportunity may be and still be listed (default 48h). */
function opportunityMaxAgeMs(): number {
  const hours = Number(process.env.DEFI_OPPORTUNITY_MAX_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 48) * 3600 * 1000;
}
