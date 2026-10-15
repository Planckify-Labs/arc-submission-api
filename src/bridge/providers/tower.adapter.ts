/**
 * `tower` — same-chain swaps on Arc through Tower Exchange.
 *
 * Tower aggregates the Arc DEXes (Aero, Uniswap, KyberSwap on mainnet;
 * Tower DEX, Synthra, XyloNet on testnet). LI.FI's Arc mainnet support is
 * dark (every quote returns "Chain 5042 is not supported"), so on Arc this
 * adapter is the only swap route.
 *
 * It docks into the bridge registry as a SAME-CHAIN route: `supports()` is
 * true only when source and destination are the same Arc chain, so it
 * never competes with LI.FI or CCTP for a cross-chain transfer, and the
 * swap reuses the whole bridge surface (quote card, re-quote at signing,
 * approval + transaction payload, progress card) with no new UI.
 *
 * Tower's output is untrusted. Before a payload reaches a wallet:
 *  - the quoted input/output tokens and input amount must equal the
 *    request (Tower silently swaps a testnet address for mainnet's when
 *    the network is not pinned);
 *  - the built transaction must target this chain, be sent from the
 *    user's address, carry no native value for a token input, and call an
 *    allowlisted executor that has contract code on-chain (Tower's
 *    testnet build points at an executor that is not deployed there);
 *  - the ERC-20 approval is rebuilt by us for exactly the input amount
 *    and exactly that executor, never taken from Tower.
 *
 * A route whose build fails (Tower's KyberSwap route 500s with
 * `BUILD_TX_FAILED`) falls back to the next venue Tower offered.
 */

import { randomUUID } from "crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type PublicClient, erc20Abi, getAddress, isAddress } from "viem";
import { DefiError } from "../../strategies/errors/defi-error";
import { findChainById } from "../../strategies/targets/chain-directory";
import { getPublicClientForChain } from "../../strategies/targets/rpc";
import { ValkeyService } from "../../valkey/valkey.service";
import { buildCaip19, parseCaip19 } from "../caip";
import { HeldFloorStore, declaredSlippageBps, shownFloor } from "../held-floor";
import { effectiveSlippageBps } from "../slippage";
import type { BridgeRouteAdapter } from "../registry";
import type {
  BridgeFee,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRef,
  BridgeRouteStep,
  BridgeStatus,
  BridgeSupportedChain,
  BridgeToken,
  Caip2,
  Caip19,
} from "../types";
import { slippageBpsFor } from "./lifi.mapping";
import {
  DEFAULT_TOWER_API_URL,
  TowerBuildError,
  type TowerBuiltTx,
  TowerClient,
  TowerNoRouteError,
  type TowerQuote,
} from "./tower.client";

interface ArcChain {
  chainId: number;
  /** Fallback display name when the chain directory has no row. */
  name: string;
}

/**
 * The chains Tower serves swaps on. Keyed by CAIP-2.
 *
 * Deliberately NOT derived from Tower's `GET /chains` (swap spec §4.8 B12
 * proposed filtering it on `supportedFeatures` including "swaps"). Live
 * check 2026-09-30: `/chains` lists Arc mainnet (5042) with only
 * `bridge`, `rpc-proxy`, `wallet-balance`, and "swaps" on Arc Testnet
 * alone, while swaps on 5042 quote and build fine. Filtering on it would
 * switch off the one working route. Revisit when Tower's feature flags
 * match reality. The platform's own chain intersection (§4.7) still
 * applies on top of this table.
 */
const ARC_CHAINS: Record<Caip2, ArcChain> = {
  "eip155:5042": { chainId: 5042, name: "Arc" },
  "eip155:5042002": { chainId: 5042002, name: "Arc Testnet" },
};

/**
 * Arc's gas token IS USDC, exposed twice: as the native balance (18
 * decimals, like every EVM native) and as an ERC-20 at this address (6
 * decimals). Both views read the same balance. Tower only speaks the
 * ERC-20 view, so a native-USDC request is converted onto it.
 */
const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const EVM_NATIVE_DECIMALS = 18;

/**
 * Tower's swap executors, per chain. The approval spender and the swap
 * target must be one of these. `TOWER_EXECUTORS_<chainId>` (comma
 * separated) overrides the default when Tower redeploys.
 */
const DEFAULT_EXECUTORS: Record<number, string[]> = {
  5042: ["0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8"],
  5042002: ["0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8"],
};

/** How many alternative venues to try when a build fails. */
const MAX_BUILD_FALLBACKS = 2;

/** Arc has sub-second deterministic finality. */
const SWAP_DURATION_SECONDS = 2;

interface ResolvedSide {
  /** The CAIP-19 the quote reports, always the ERC-20 view. */
  caip19: Caip19;
  address: string;
  token: BridgeToken;
}

/**
 * Tower's `priceImpact` is in BASIS POINTS, not the "percentage" its docs
 * claim (live-verified 2026-09-30 on Arc mainnet: 100k USDC -> EURC reports
 * 14 while the rate moved ~0.12%; small trades report 0-2). The wire type
 * carries PERCENT, so convert here and nowhere else. Absent stays absent.
 */
export function towerPriceImpactPercent(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw / 100
    : undefined;
}

@Injectable()
export class TowerSwapAdapter implements BridgeRouteAdapter {
  readonly key = "tower";
  readonly kinds = ["swap"] as const;

  private readonly logger = new Logger(TowerSwapAdapter.name);
  private readonly client: TowerClient;
  private readonly executors: Map<number, Set<string>>;
  private readonly tokenCache = new Map<string, BridgeToken>();
  private readonly floors: HeldFloorStore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() valkey?: ValkeyService,
  ) {
    this.floors = new HeldFloorStore(valkey, this.key);
    this.client = new TowerClient(
      this.configService.get<string>("TOWER_API_KEY") || "",
      this.configService.get<string>("TOWER_API_URL") || DEFAULT_TOWER_API_URL,
    );
    this.executors = new Map();
    for (const { chainId } of Object.values(ARC_CHAINS)) {
      const override = this.configService.get<string>(
        `TOWER_EXECUTORS_${chainId}`,
      );
      const list = override
        ? override.split(",").map((a) => a.trim())
        : (DEFAULT_EXECUTORS[chainId] ?? []);
      this.executors.set(
        chainId,
        new Set(list.filter((a) => isAddress(a)).map((a) => a.toLowerCase())),
      );
    }
    const key = this.configService.get<string>("TOWER_API_KEY") || "";
    if (key) {
      this.logger.log(`Tower swaps enabled (key ${key.slice(0, 8)}…)`);
    } else {
      this.logger.warn("Tower swaps disabled: TOWER_API_KEY is not set");
    }
  }

  // ── capability seam ───────────────────────────────────────────────────

  supports(from: Caip2, to: Caip2): boolean {
    return from === to && from in ARC_CHAINS && this.client.isConfigured();
  }

  toProviderChainId(c: Caip2): number | null {
    return ARC_CHAINS[c]?.chainId ?? null;
  }

  toProviderAsset(a: Caip19): string | null {
    const parsed = parseCaip19(a);
    if (!parsed || !(parsed.chain in ARC_CHAINS)) return null;
    if (parsed.assetNamespace === "slip44") return ARC_USDC_ERC20;
    if (parsed.assetNamespace === "erc20" && isAddress(parsed.assetReference)) {
      return parsed.assetReference.toLowerCase();
    }
    return null;
  }

  // ── quote ─────────────────────────────────────────────────────────────

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const arc = ARC_CHAINS[req.fromChain];
    if (!arc || req.toChain !== req.fromChain) {
      throw new DefiError("unsupported_chain", "tower serves same-chain Arc");
    }
    // Tower has no recipient parameter: the executor pays the signer.
    if (!sameAddress(req.toAddress, req.fromAddress)) {
      throw new DefiError(
        "unsupported_asset",
        "tower swaps pay the sender only",
      );
    }

    const client = this.rpc(arc.chainId);
    const from = await this.resolveSide(req.fromAsset, arc.chainId, client);
    const to = await this.resolveSide(req.toAsset, arc.chainId, client);
    if (sameAddress(from.address, to.address)) {
      throw new DefiError("unsupported_asset", "same token on both sides");
    }

    const amountRaw = toErc20Amount(req.fromAsset, req.amountRaw, from.token);
    if (amountRaw === 0n) {
      throw new DefiError("unsupported_asset", "amount rounds to zero");
    }
    const defaultBps = slippageBpsFor(from.token.symbol, to.token.symbol);
    // The floor the user was shown for this exact swap: sent by the device
    // (5.26+), else remembered from the card quote (see held-floor.ts). A
    // pinned slippage (internal callers) bypasses it.
    const floorKey = this.floors.key({
      chainId: arc.chainId,
      wallet: req.fromAddress,
      inputToken: from.address,
      outputToken: to.address,
      amountRaw: amountRaw.toString(),
    });
    const held =
      req.slippageBps !== undefined
        ? null
        : (parseRaw(req.minReceiveRaw) ?? (await this.floors.get(floorKey)));
    const slippageBps = effectiveSlippageBps(defaultBps, {
      slippageBps: req.slippageBps,
      minReceiveRaw: held?.toString(),
    });

    const { quote, built } = await this.quoteAndBuild({
      chainId: arc.chainId,
      from,
      to,
      amountRaw: amountRaw.toString(),
      slippageBps,
      userAddress: req.fromAddress,
    });

    const executor = await this.checkExecution(
      built,
      arc.chainId,
      req.fromAddress,
      client,
    );

    // checkQuote guaranteed both parse.
    const outRaw = BigInt(quote.outputAmountRaw as string);
    const floor = shownFloor({
      outRaw,
      onChainMin: BigInt(quote.minOutRaw as string),
      defaultBps,
      held,
    });
    if (req.slippageBps === undefined) await this.floors.set(floorKey, floor);

    return this.toBridgeQuote({
      req,
      quote,
      built,
      executor,
      from,
      to,
      amountRaw: amountRaw.toString(),
      floor,
      slippageBps:
        held === null ? slippageBps : declaredSlippageBps(outRaw, floor),
    });
  }

  /**
   * Quote, then build. A build that Tower refuses (its KyberSwap route
   * currently 500s) retries the next venue it offered, re-quoted with that
   * `dexId` so the retried quote carries its own expiry.
   */
  private async quoteAndBuild(args: {
    chainId: number;
    from: ResolvedSide;
    to: ResolvedSide;
    amountRaw: string;
    slippageBps: number;
    userAddress: string;
  }): Promise<{ quote: TowerQuote; built: TowerBuiltTx }> {
    const request = {
      chainId: args.chainId,
      inputToken: args.from.address,
      outputToken: args.to.address,
      inputAmount: args.amountRaw,
      slippageBps: args.slippageBps,
    };

    let first: TowerQuote;
    try {
      first = await this.client.quote(request);
    } catch (error: unknown) {
      throw this.noRoute(error);
    }

    const venues = [
      undefined,
      ...(first.routeOptions ?? [])
        .map((o) => o.dexId)
        .filter((d): d is string => !!d && d !== first.dexId),
    ].slice(0, 1 + MAX_BUILD_FALLBACKS);

    for (const dexId of venues) {
      let quote = first;
      try {
        if (dexId) quote = await this.client.quote({ ...request, dexId });
        this.checkQuote(quote, args);
        const built = await this.client.buildTx(
          quote,
          args.userAddress,
          args.chainId,
        );
        return { quote, built };
      } catch (error: unknown) {
        if (error instanceof TowerBuildError) continue;
        if (error instanceof TowerNoRouteError) continue;
        throw error;
      }
    }
    throw new DefiError("unsupported_asset", "no tower venue could build");
  }

  /** The quote must be for exactly what was asked. */
  private checkQuote(
    quote: TowerQuote,
    args: { from: ResolvedSide; to: ResolvedSide; amountRaw: string },
  ): void {
    if (!sameAddress(quote.inputToken, args.from.address)) {
      throw new DefiError("decoded_intent_mismatch", "tower input token");
    }
    if (!sameAddress(quote.outputToken, args.to.address)) {
      throw new DefiError("decoded_intent_mismatch", "tower output token");
    }
    if (quote.inputAmountRaw !== args.amountRaw) {
      throw new DefiError("decoded_intent_mismatch", "tower input amount");
    }
    if (
      (quote.inputTokenDecimals !== undefined &&
        quote.inputTokenDecimals !== args.from.token.decimals) ||
      (quote.outputTokenDecimals !== undefined &&
        quote.outputTokenDecimals !== args.to.token.decimals)
    ) {
      throw new DefiError("decimals_mismatch", "tower token decimals");
    }
    const out = parseRaw(quote.outputAmountRaw);
    const min = parseRaw(quote.minOutRaw);
    if (out === null || min === null || min > out || min === 0n) {
      throw new DefiError("network_error", "tower quote missing raw amounts");
    }
  }

  /**
   * The built transaction must be on this chain, from this user, carry no
   * native value, and call an allowlisted executor that is deployed.
   * Returns the checksummed executor address.
   */
  private async checkExecution(
    built: TowerBuiltTx,
    chainId: number,
    userAddress: string,
    client: PublicClient,
  ): Promise<string> {
    const swap = built.swap;
    if (swap.chainId !== undefined && Number(swap.chainId) !== chainId) {
      throw new DefiError("decoded_intent_mismatch", "tower tx chain");
    }
    if (swap.from && !sameAddress(swap.from, userAddress)) {
      throw new DefiError("decoded_intent_mismatch", "tower tx sender");
    }
    if (!isAddress(swap.to) || !/^0x[0-9a-fA-F]*$/.test(swap.data ?? "")) {
      throw new DefiError("decoded_intent_mismatch", "tower tx malformed");
    }
    if (parseRaw(swap.value ?? "0") !== 0n) {
      throw new DefiError("decoded_intent_mismatch", "tower tx carries value");
    }
    // We rebuild the approval ourselves, but a Tower approval naming a
    // different spender than the swap target means the payload is not
    // what it claims to be.
    const spender = built.approval?.spender;
    if (spender && !sameAddress(spender, swap.to)) {
      throw new DefiError("decoded_intent_mismatch", "tower approval spender");
    }
    if (!this.executors.get(chainId)?.has(swap.to.toLowerCase())) {
      throw new DefiError("target_not_allowlisted", "tower executor");
    }

    let code: string | undefined;
    try {
      code = await client.getCode({ address: getAddress(swap.to) });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[checkExecution] getCode failed: ${detail}`);
      throw new DefiError("network_error", "executor code check failed");
    }
    if (!code || code === "0x") {
      throw new DefiError("target_not_a_contract", "tower executor");
    }
    return getAddress(swap.to);
  }

  private toBridgeQuote(args: {
    req: BridgeQuoteRequest;
    quote: TowerQuote;
    built: TowerBuiltTx;
    executor: string;
    from: ResolvedSide;
    to: ResolvedSide;
    amountRaw: string;
    /** The floor reported to the device; never above the on-chain minimum. */
    floor: bigint;
    slippageBps: number;
  }): BridgeQuote {
    const { req, quote, built, executor, from, to, amountRaw } = args;
    const chainName = this.chainName(req.fromChain);
    // An auto-routed quote names its venue only on the first hop.
    // Co-marketing: a Tower swap is presented as Tower, never as the DEX
    // Tower routed through underneath (KyberSwap and so on). The DEX stays
    // in `routeOptions` for diagnostics only.
    const provider = {
      key: this.key,
      name: "Tower",
      mechanism: "liquidity_pool" as const,
    };

    const fees: BridgeFee[] = [];
    const feeRaw = parseRaw(quote.platformFeeAmountRaw);
    if (feeRaw !== null && feeRaw > 0n) {
      fees.push({
        key: "other",
        label: "Swap fee",
        amountRaw: feeRaw.toString(),
        token: from.token,
        // Taken from the input before the swap, so the output already
        // reflects it.
        included: true,
      });
    }

    const steps: BridgeRouteStep[] = [
      {
        key: "approve",
        kind: "approve",
        label: `Allow ${from.token.symbol} to be swapped`,
        fromChain: req.fromChain,
        fromToken: from.token,
        fromAmountRaw: amountRaw,
      },
      {
        key: "swap",
        kind: "swap",
        label: `Swap ${from.token.symbol} to ${to.token.symbol}`,
        fromChain: req.fromChain,
        toChain: req.toChain,
        fromToken: from.token,
        toToken: to.token,
        fromAmountRaw: amountRaw,
        toAmountRaw: quote.outputAmountRaw,
        provider,
      },
    ];

    const issuedAt = new Date();
    const towerExpiry = quote.expiresAt ? Date.parse(quote.expiresAt) : NaN;
    const expiresAt = Number.isFinite(towerExpiry)
      ? new Date(towerExpiry)
      : new Date(issuedAt.getTime() + 60_000);

    return {
      quoteId: randomUUID(),
      provider: this.key,
      from: {
        chain: req.fromChain,
        chainName,
        token: from.token,
        address: req.fromAddress,
        amountRaw,
      },
      to: {
        chain: req.toChain,
        chainName,
        token: to.token,
        address: req.fromAddress,
        amountRaw: quote.outputAmountRaw as string,
      },
      toAmountMinRaw: args.floor.toString(),
      kind: "swap",
      priceImpact: towerPriceImpactPercent(quote.priceImpact),
      // The venue that actually won, named the same way the provider label
      // above names it (an auto-routed quote carries it on the first hop).
      venue: { key: this.key, name: "Tower" },
      routeOptions: quote.routeOptions?.map((o) => ({
        dexId: o.dexId,
        name: o.dexName ?? o.dexId ?? "Unknown",
        outputAmountRaw: o.outputAmountRaw,
        minOutRaw: o.minOutRaw,
        priceImpact: towerPriceImpactPercent(o.priceImpact),
      })),
      slippageBps: args.slippageBps,
      fees,
      receivesNativeAsset: false,
      durationSeconds: SWAP_DURATION_SECONDS,
      bridge: provider,
      steps,
      execution: {
        kind: "evm_transaction",
        chain: req.fromChain,
        to: executor,
        data: built.swap.data,
        value: "0",
        gasLimit: decimalString(built.swap.gasLimit),
        // Always present, whatever Tower said: the wallet kit reads the
        // current allowance and only signs an approve when it is short.
        approval: {
          token: from.address,
          spender: executor,
          amountRaw,
        },
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ── status: a same-chain swap is settled when its receipt lands ──────

  async status(ref: BridgeRef): Promise<BridgeStatus> {
    const arc = ARC_CHAINS[ref.fromChain];
    if (!arc) {
      throw new DefiError("unsupported_chain", "tower status off Arc");
    }
    const client = this.rpc(arc.chainId);
    const hash = ref.sourceTxHash as `0x${string}`;

    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch (error: unknown) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TransactionReceiptNotFoundError") {
        return {
          outcome: null,
          phase: "pending_source",
          currentStepKey: "swap",
          sourceTxHash: ref.sourceTxHash,
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[status] receipt read failed: ${detail}`);
      throw new DefiError("network_error", "swap status unavailable");
    }

    const succeeded = receipt.status === "success";
    return {
      outcome: succeeded ? "completed" : "failed",
      phase: "settled",
      sourceTxHash: ref.sourceTxHash,
      destinationTxHash: succeeded ? ref.sourceTxHash : undefined,
    };
  }

  // ── support matrix ────────────────────────────────────────────────────

  async listSupportedChains(): Promise<BridgeSupportedChain[]> {
    if (!this.client.isConfigured()) return [];
    return Object.keys(ARC_CHAINS).map((chain) => ({
      chain,
      name: this.chainName(chain),
      providers: [this.key],
      nativeSymbol: "USDC",
    }));
  }

  listTools(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── token metadata ────────────────────────────────────────────────────

  async resolveToken(asset: Caip19): Promise<BridgeToken | null> {
    const parsed = parseCaip19(asset);
    const arc = parsed ? ARC_CHAINS[parsed.chain] : undefined;
    if (!parsed || !arc) return null;
    try {
      const client = this.rpc(arc.chainId);
      if (parsed.assetNamespace === "slip44") {
        return {
          caip19: asset,
          chain: parsed.chain,
          address: "",
          symbol: "USDC",
          name: "USD Coin",
          decimals: EVM_NATIVE_DECIMALS,
          isNative: true,
          verification: "verified",
        };
      }
      return (await this.resolveSide(asset, arc.chainId, client)).token;
    } catch {
      return null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Resolve one side of the swap to its ERC-20 view. Native Arc USDC maps
   * onto the USDC ERC-20. Symbol and decimals are read on-chain, never
   * taken from Tower or a constant.
   */
  private async resolveSide(
    asset: Caip19,
    chainId: number,
    client: PublicClient,
  ): Promise<ResolvedSide> {
    const address = this.toProviderAsset(asset);
    const chain = parseCaip19(asset)?.chain;
    if (!address || !chain || ARC_CHAINS[chain]?.chainId !== chainId) {
      throw new DefiError(
        "unsupported_asset",
        "asset not expressible for tower",
      );
    }

    const cacheKey = `${chainId}:${address}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached) return { caip19: cached.caip19, address, token: cached };

    let symbol: string;
    let decimals: number;
    try {
      const token = getAddress(address);
      [symbol, decimals] = await Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "symbol",
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      ]);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[resolveSide] ${address} metadata read failed: ${detail}`,
      );
      throw new DefiError("unsupported_asset", "token metadata unreadable");
    }

    const token: BridgeToken = {
      caip19: buildCaip19(chain, "erc20", address),
      chain,
      address,
      symbol,
      decimals: Number(decimals),
      isNative: false,
      verification: "unknown",
    };
    this.tokenCache.set(cacheKey, token);
    return { caip19: token.caip19, address, token };
  }

  /**
   * Read client for the chain, from its `Blockchain` row. No row (Arc
   * mainnet before it is seeded) means no quote: every safety check reads
   * the chain, so there is nothing to fall back to.
   */
  private rpc(chainId: number): PublicClient {
    const client = getPublicClientForChain(chainId);
    if (!client) {
      throw new DefiError("unsupported_chain", `no rpc for chain ${chainId}`);
    }
    return client;
  }

  private chainName(chain: Caip2): string {
    const arc = ARC_CHAINS[chain];
    if (!arc) return chain;
    return findChainById(arc.chainId)?.name ?? arc.name;
  }

  private noRoute(error: unknown): unknown {
    if (error instanceof TowerNoRouteError) {
      return new DefiError("unsupported_asset", "tower has no route");
    }
    return error;
  }
}

/**
 * The request amount in the ERC-20's smallest unit. Native Arc USDC is 18
 * decimals and its ERC-20 view is 6, so a native amount is scaled down and
 * sub-unit dust stays in the wallet.
 */
function toErc20Amount(
  asset: Caip19,
  amountRaw: string,
  erc20: BridgeToken,
): bigint {
  const amount = BigInt(amountRaw);
  if (parseCaip19(asset)?.assetNamespace !== "slip44") return amount;
  const shift = EVM_NATIVE_DECIMALS - erc20.decimals;
  if (shift < 0) {
    throw new DefiError("decimals_mismatch", "native USDC decimals");
  }
  return amount / 10n ** BigInt(shift);
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  // EVM hex addresses fold case. Only EVM addresses reach this adapter.
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function parseRaw(v: string | undefined): bigint | null {
  if (v === undefined || v === null || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Tower sends hex (`0x10c8e0`); the wire type is a decimal string. */
function decimalString(v: string | undefined): string | undefined {
  const n = parseRaw(v);
  return n === null ? undefined : n.toString();
}
