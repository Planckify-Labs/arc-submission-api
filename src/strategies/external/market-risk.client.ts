import { Injectable, Logger } from "@nestjs/common";
import { ValkeyService } from "../../valkey/valkey.service";
import { findChainByName } from "../targets/chain-directory";
import { marketApiConfig } from "../targets/candidates/market-pool-address.source";
import type { DepositTarget } from "../targets/types";
import type { DeFiLlamaYieldPool } from "./defillama.client";

/**
 * Exit-side risk for one pool, read from our market API at score time and
 * stored on the row (`OpportunityCache.riskSignals`), so the app can say what
 * is true before a user signs:
 *
 *   - exploit history (DeFiLlama's hacks list, matched per protocol by the
 *     market API) — a recent loss that was not returned BLOCKS new deposits;
 *   - lending liquidity (`/api/yields/borrow`: supply, borrows, what is free
 *     to withdraw) — a market that is nearly fully borrowed warns that exits
 *     may have to wait;
 *   - LST peg (`/api/yields/lsd`: market rate vs redemption rate) — a token
 *     trading below its redemption value warns that a DEX exit loses it.
 *
 * Nothing here ever blocks a WITHDRAW. A crisis is a reason to let people out,
 * so exit-side facts reach withdrawers as information only.
 *
 * Every threshold is ops config. A market API that is unconfigured or down
 * yields `null` — no signals, and nothing claimed either way.
 */

export type RiskWarning =
  | "recent_exploit"
  | "past_exploit"
  | "low_liquidity"
  | "lst_discount";

export interface RiskSignals {
  v: 1;
  at: string;
  exploit?: { date: string; lostUsd: number; returnedUsd: number };
  liquidity?: { availableUsd: number; utilizationBps: number };
  lstPegBps?: number;
  /** Set => in-app deposits refused (Layer 3 on the device). */
  depositBlock: "recent_exploit" | null;
  warnings: RiskWarning[];
}

interface Hack {
  date?: string;
  amountUsd?: number | null;
  returnedUsd?: number | null;
}

interface BorrowPool {
  project?: string;
  chain?: string;
  underlyingTokens?: string[];
  totalSupplyUsd?: number;
  totalBorrowUsd?: number;
  availableBorrowUsd?: number;
}

interface LsdToken {
  address?: string;
  ethPeg?: number;
}

const HOUR = 3600;

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Same chain, whichever spelling each side uses ("avax" vs "Avalanche"). */
function sameChain(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const ra = findChainByName(a);
  return !!ra && ra === findChainByName(b);
}

/** Pure policy over the facts; exported for tests. */
export function riskVerdict(
  facts: Pick<RiskSignals, "exploit" | "liquidity" | "lstPegBps">,
  now = Date.now(),
): Pick<RiskSignals, "depositBlock" | "warnings"> {
  const warnings: RiskWarning[] = [];
  let depositBlock: RiskSignals["depositBlock"] = null;

  if (facts.exploit) {
    const ageDays = (now - Date.parse(facts.exploit.date)) / 86_400_000;
    const unreturned = facts.exploit.lostUsd - facts.exploit.returnedUsd;
    if (unreturned > 0 && ageDays <= envNumber("DEFI_EXPLOIT_BLOCK_DAYS", 30)) {
      depositBlock = "recent_exploit";
      warnings.push("recent_exploit");
    } else if (ageDays <= envNumber("DEFI_EXPLOIT_WARN_DAYS", 365)) {
      warnings.push("past_exploit");
    }
  }
  if (
    facts.liquidity &&
    facts.liquidity.utilizationBps >=
      envNumber("DEFI_UTILIZATION_WARN_BPS", 9_500)
  ) {
    warnings.push("low_liquidity");
  }
  if (
    typeof facts.lstPegBps === "number" &&
    facts.lstPegBps <= -envNumber("DEFI_LST_DISCOUNT_WARN_BPS", 100)
  ) {
    warnings.push("lst_discount");
  }
  return { depositBlock, warnings };
}

@Injectable()
export class MarketRiskClient {
  private readonly logger = new Logger(MarketRiskClient.name);

  constructor(private readonly valkey: ValkeyService) {}

  async forPool(
    pool: DeFiLlamaYieldPool,
    target: DepositTarget | null,
  ): Promise<RiskSignals | null> {
    const config = marketApiConfig();
    if (!config) return null;

    const [metaHacks, listedHacks, borrow, lsd] = await Promise.all([
      this.get<{ risk?: { hacks?: Hack[] } }>(
        config,
        `market:risk:meta:${pool.project}:v1`,
        `/api/metadata/${encodeURIComponent(pool.project)}`,
        6 * HOUR,
      ).then((r) => r?.risk?.hacks ?? null),
      // The per-protocol match above misses hacks recorded without a
      // DeFiLlama id (seen: Yapeswap, 2026-10-25). The full list carries the
      // slug the market API resolved, so it is checked too.
      this.get<{ hacks?: Array<Hack & { protocol?: string | null }> }>(
        config,
        "market:risk:hacks:v1",
        "/api/hacks?limit=1000",
        6 * HOUR,
      ).then(
        (r) => r?.hacks?.filter((h) => h.protocol === pool.project) ?? null,
      ),
      this.get<{ pools?: BorrowPool[] }>(
        config,
        `market:risk:borrow:${pool.project}:v1`,
        `/api/yields/borrow?project=${encodeURIComponent(pool.project)}&limit=500`,
        HOUR,
      ).then((r) => r?.pools ?? null),
      target?.kind === "lst-stake"
        ? this.get<{ tokens?: LsdToken[] }>(
            config,
            "market:risk:lsd:v1",
            "/api/yields/lsd",
            HOUR,
          ).then((r) => r?.tokens ?? null)
        : Promise.resolve(null),
    ]);
    if (
      metaHacks === null &&
      listedHacks === null &&
      borrow === null &&
      lsd === null
    )
      return null;
    const hacks = [...(metaHacks ?? []), ...(listedHacks ?? [])];

    const facts: Pick<RiskSignals, "exploit" | "liquidity" | "lstPegBps"> = {};

    const latest = hacks
      .filter((h) => typeof h.date === "string")
      .sort(
        (a, b) => Date.parse(b.date as string) - Date.parse(a.date as string),
      )[0];
    if (latest) {
      facts.exploit = {
        date: latest.date as string,
        lostUsd: latest.amountUsd ?? 0,
        returnedUsd: latest.returnedUsd ?? 0,
      };
    }

    const underlying = pool.underlyingTokens?.[0]?.toLowerCase();
    const market = underlying
      ? (borrow ?? []).find(
          (b) =>
            b.underlyingTokens?.[0]?.toLowerCase() === underlying &&
            sameChain(b.chain, pool.chain),
        )
      : undefined;
    if (market && (market.totalSupplyUsd ?? 0) > 0) {
      const supply = market.totalSupplyUsd as number;
      const borrowed = Math.min(market.totalBorrowUsd ?? 0, supply);
      facts.liquidity = {
        availableUsd: market.availableBorrowUsd ?? supply - borrowed,
        utilizationBps: Math.round((borrowed / supply) * 10_000),
      };
    }

    if (target?.kind === "lst-stake" && lsd) {
      const receipt = target.receipt.toLowerCase();
      const token = lsd.find((t) => t.address?.toLowerCase() === receipt);
      if (typeof token?.ethPeg === "number") {
        facts.lstPegBps = Math.round(token.ethPeg * 100);
      }
    }

    return {
      v: 1,
      at: new Date().toISOString(),
      ...facts,
      ...riskVerdict(facts),
    };
  }

  /** Valkey-cached GET. Null on any failure; a failure is not cached. */
  private async get<T>(
    config: { url: string; key: string },
    cacheKey: string,
    path: string,
    ttlSec: number,
  ): Promise<T | null> {
    const cached = await this.valkey.get<T>(cacheKey).catch(() => null);
    if (cached) return cached;
    try {
      const res = await fetch(`${config.url}${path}`, {
        headers: { Accept: "application/json", "X-API-Key": config.key },
        signal: AbortSignal.timeout(20_000),
      });
      // 424 = "no data for this protocol here": an answer, not an outage.
      if (res.status === 424) {
        await this.valkey
          .set(cacheKey, {} as object, { ttl: ttlSec })
          .catch(() => undefined);
        return {} as T;
      }
      if (!res.ok) return null;
      const body = (await res.json()) as T;
      await this.valkey
        .set(cacheKey, body as object, { ttl: ttlSec })
        .catch(() => undefined);
      return body;
    } catch (err) {
      this.logger.warn(
        `[market-risk] ${path} failed: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }
}
