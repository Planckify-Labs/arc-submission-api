/**
 * `lifi` — the general-purpose `BridgeRouteAdapter`.
 *
 * Spec: docs/bridge-capability-spec.md §5.2, §5.3, §2.2.
 *
 * LI.FI aggregates 35 bridges across 72 chains (69 EVM + Solana + Sui +
 * Bitcoin) and already reaches CCTP through four tool keys (§2.1), so this
 * one adapter covers every namespace we ship EXCEPT Stellar. It routes
 * ARBITRARY tokens, which is the real answer to "what besides USDC" and
 * needs zero new integrations — only that we stop blocking it (§4).
 *
 * Everything LI.FI-shaped stays behind this boundary: its private chain
 * numbering, its tool keys, its status vocabulary. Callers speak CAIP-2 /
 * CAIP-19 and the four-value `BridgeOutcome`.
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChainType,
  createConfig,
  type ExtendedChain,
  getChains,
  getConnections,
  getQuote,
  getStatus,
  getToken,
  getTokens,
  getTools,
  type LiFiStep,
  type StatusResponse,
} from "@lifi/sdk";
import { randomUUID } from "crypto";
import { DefiError } from "../../strategies/errors/defi-error";
import { isNativeAsset, parseCaip2, parseCaip19 } from "../caip";
import { effectiveSlippageBps } from "../slippage";
import type { BridgeRouteAdapter } from "../registry";
import type {
  BridgeExecutionPayload,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRef,
  BridgeStatus,
  BridgeSupportedChain,
  BridgeToken,
  Caip19,
  Caip2,
  GasTopUpRequest,
} from "../types";
import {
  caip19ToLifiToken,
  caip2ToLifiChainId,
  lifiChainIdToCaip2,
  receivesNativeIssuance,
  slippageBpsFor,
  toBridgeFees,
  toBridgeProviderInfo,
  toBridgeStatus,
  toBridgeSteps,
  toBridgeToken,
  toSupportedChain,
} from "./lifi.mapping";

const DEFAULT_INTEGRATOR = "takumipay";

/** Support-matrix cache TTL (§5.3). Stale-while-revalidate on top. */
const SUPPORT_TTL_MS = 60 * 60 * 1000;

/**
 * Quote freshness window (§8.2). A user can read an agent message minutes
 * later and approve a dead route, which is the `stale_precondition`
 * recovery class — so the quote carries an issued-at + TTL and the card
 * offers a re-quote rather than submitting a stale route.
 */
const QUOTE_TTL_MS = 60 * 1000;

/**
 * LI.FI's gas-top-up bridge key (§7.5). Routing a small slice through it
 * is what turns the "no gas on the destination" warning into an actionable
 * remedy instead of a dead end.
 */
const GAS_ZIP_BRIDGE = "gaszip";

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * LI.FI's estimate carries no `priceImpact` (verified live). Derive it, in
 * PERCENT, from the USD value in vs out. It includes the protocol fee, so it
 * errs toward warning the user. Absent USD figures stay absent (unknown is
 * never 0).
 */
export function lifiPriceImpactPercent(estimate: {
  fromAmountUSD?: string;
  toAmountUSD?: string;
  priceImpact?: number;
}): number | undefined {
  if (typeof estimate.priceImpact === "number") return estimate.priceImpact;
  const from = Number.parseFloat(estimate.fromAmountUSD ?? "");
  const to = Number.parseFloat(estimate.toAmountUSD ?? "");
  // A zero or missing output value means LI.FI has no price for the token,
  // not that the user receives nothing: that is UNKNOWN, never 100%.
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return undefined;
  }
  return Math.max(0, ((from - to) / from) * 100);
}

/**
 * LI.FI marks scam / impersonation tokens `flagged` in a REST field its
 * published types do not declare, so it is read defensively.
 */
function isLifiFlagged(token: object): boolean {
  const raw = (token as { verificationStatus?: unknown }).verificationStatus;
  return typeof raw === "string" && raw.toLowerCase() === "flagged";
}

/** How long a chain's LI.FI token list is served from memory. */
const TOKEN_LIST_TTL_MS = 60 * 60 * 1000;
/** Tokens kept per chain for the picker; search covers the long tail. */
const TOKEN_LIST_LIMIT = 60;

@Injectable()
export class LifiBridgeAdapter implements BridgeRouteAdapter {
  readonly key = "lifi";
  readonly kinds = ["swap", "bridge"] as const;

  private readonly logger = new Logger(LifiBridgeAdapter.name);
  private readonly tokenListCache = new Map<
    Caip2,
    { at: number; tokens: BridgeToken[] }
  >();
  /** `from|to` → the token addresses LI.FI connects (lowercased). */
  private readonly connectionsCache = new Map<
    string,
    { at: number; from: Set<string>; to: Set<string> }
  >();
  private readonly integrator: string;
  private readonly apiKey: string;
  /**
   * Integrator fee stays 0 (§10.2): we have no bridge volume yet and the
   * user already pays bridge fee + gas + slippage. If it is ever switched
   * on it MUST appear in the §7.2 breakdown, never silently — which is
   * why `quote()` emits a fee line whenever this is non-zero.
   */
  private readonly integratorFeeBps: number;

  private chainsCache: CacheEntry<ExtendedChain[]> | null = null;
  private toolsCache: CacheEntry<string[]> | null = null;
  private chainsInFlight: Promise<ExtendedChain[]> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.integrator =
      this.configService.get<string>("LIFI_INTEGRATOR") || DEFAULT_INTEGRATOR;
    this.apiKey = this.configService.get<string>("LIFI_API_KEY") || "";
    this.integratorFeeBps = Number.parseInt(
      this.configService.get<string>("LIFI_INTEGRATOR_FEE_BPS") ?? "0",
      10,
    );

    // `createConfig` is global to the SDK; the Nest singleton lifecycle
    // guarantees one call. `preloadChains: false` is deliberate — the SDK
    // otherwise fires an eager detached `getChains()` whose rejection has
    // nothing awaiting it, which took the whole API process down when
    // li.quest 404'd. See the same note in `strategies/external/lifi.client.ts`.
    createConfig({
      integrator: this.integrator,
      preloadChains: false,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
    });
  }

  // ── capability seam (§5.2) ────────────────────────────────────────────

  supports(from: Caip2, to: Caip2): boolean {
    const fromId = caip2ToLifiChainId(from);
    const toId = caip2ToLifiChainId(to);
    if (fromId === null || toId === null) return false;

    // Bitcoin is reachable by LI.FI but we have no BTC wallet, so we cannot
    // sign either leg (§1 non-goals). Report it as out of scope rather than
    // quoting a route the user can never execute.
    if (this.isBitcoin(from) || this.isBitcoin(to)) return false;

    // When the chain list is already warm, honour it. A cold cache must not
    // produce a wrong "unsupported" (§5.3) — so we optimistically allow and
    // let `quote()` surface the real answer.
    const chains = this.chainsCache?.value;
    if (!chains) return true;
    const ids = new Set(chains.map((c) => c.id));
    return ids.has(fromId) && ids.has(toId);
  }

  private isBitcoin(chain: Caip2): boolean {
    return parseCaip2(chain)?.namespace === "bip122";
  }

  toProviderChainId(c: Caip2): string | number | null {
    return caip2ToLifiChainId(c);
  }

  toProviderAsset(a: Caip19): string | null {
    return caip19ToLifiToken(a);
  }

  // ── quote ─────────────────────────────────────────────────────────────

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const fromChainId = caip2ToLifiChainId(req.fromChain);
    const toChainId = caip2ToLifiChainId(req.toChain);
    const fromToken = caip19ToLifiToken(req.fromAsset);
    const toToken = caip19ToLifiToken(req.toAsset);

    if (fromChainId === null || toChainId === null) {
      throw new DefiError("unsupported_chain", "chain not routable by LI.FI");
    }
    if (!fromToken || !toToken) {
      throw new DefiError("unsupported_asset", "asset not expressible for LI.FI");
    }

    const slippageBps =
      req.slippageBps ??
      effectiveSlippageBps(
        await this.defaultSlippageBps(req.fromAsset, req.toAsset),
        req,
      );

    let step: LiFiStep;
    try {
      step = await getQuote({
        fromChain: fromChainId,
        toChain: toChainId,
        fromToken,
        toToken,
        fromAmount: req.amountRaw,
        fromAddress: req.fromAddress,
        toAddress: req.toAddress,
        slippage: slippageBps / 10_000,
        integrator: this.integrator,
        ...(this.integratorFeeBps > 0
          ? { fee: this.integratorFeeBps / 10_000 }
          : {}),
      });
    } catch (error: unknown) {
      // The SDK throws `LiFiError` with its own codes and messages. We log
      // the detail and return our own curated code — an upstream body must
      // never reach a thrown `Error.message` that React Query would render
      // (CLAUDE.md user-facing errors).
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[quote] LI.FI declined route: ${detail}`);
      throw new DefiError("network_error", detail);
    }

    return this.stepToQuote(step, req, slippageBps);
  }

  private async defaultSlippageBps(
    fromAsset: Caip19,
    toAsset: Caip19,
  ): Promise<number> {
    const [from, to] = await Promise.all([
      this.resolveToken(fromAsset).catch(() => null),
      this.resolveToken(toAsset).catch(() => null),
    ]);
    return slippageBpsFor(from?.symbol, to?.symbol);
  }

  private stepToQuote(
    step: LiFiStep,
    req: BridgeQuoteRequest,
    slippageBps: number,
  ): BridgeQuote {
    const estimate = step.estimate;
    if (!estimate) {
      throw new DefiError("network_error", "LI.FI step missing estimate");
    }

    const fromChain = req.fromChain;
    const toChain = req.toChain;
    const fromToken = toBridgeToken(fromChain, step.action.fromToken);
    const toToken = toBridgeToken(toChain, step.action.toToken);

    const sourceIsNative = isNativeAsset(req.fromAsset);
    const needsApproval = Boolean(
      !sourceIsNative &&
        estimate.approvalAddress &&
        parseCaip2(fromChain)?.namespace === "eip155",
    );

    const fees = toBridgeFees(estimate, fromChain, toChain);
    if (this.integratorFeeBps > 0 && !fees.some((f) => f.key === "integrator")) {
      // Decision §10.2: the integrator fee may be zero, but if it is ever
      // switched on it must be VISIBLE. Never let it ride silently inside
      // the output amount.
      fees.push({
        key: "integrator",
        label: "Service fee",
        amountRaw: "0",
        token: fromToken,
        included: true,
      });
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + QUOTE_TTL_MS);

    return {
      quoteId: randomUUID(),
      provider: this.key,
      from: {
        chain: fromChain,
        chainName: this.chainNameFor(fromChain),
        token: fromToken,
        address: req.fromAddress,
        amountRaw: estimate.fromAmount ?? req.amountRaw,
        amountUsd: estimate.fromAmountUSD,
      },
      to: {
        chain: toChain,
        chainName: this.chainNameFor(toChain),
        token: toToken,
        // Explicit destination address (§7.4). Cross-namespace this is a
        // COMPLETELY different address derived from the same mnemonic, and
        // hiding it is how funds go missing.
        address: step.action.toAddress ?? req.toAddress,
        amountRaw: estimate.toAmount ?? "0",
        amountUsd: estimate.toAmountUSD,
      },
      // The worst-case guarantee. Without it there is no protection number
      // on screen at all (§6). LI.FI always supplies it; the fallback only
      // covers a malformed payload.
      toAmountMinRaw: estimate.toAmountMin ?? estimate.toAmount ?? "0",
      kind: fromChain === toChain ? "swap" : "bridge",
      priceImpact: lifiPriceImpactPercent(estimate),
      venue: {
        key: step.tool,
        name: step.toolDetails?.name ?? step.tool,
        logoUri: step.toolDetails?.logoURI,
      },
      slippageBps,
      fees,
      // Destination token is native gas currency (§7.1).
      receivesNativeAsset: toToken.isNative,
      durationSeconds: Number(estimate.executionDuration ?? 0),
      bridge: toBridgeProviderInfo(step),
      steps: toBridgeSteps(step, fromChain, toChain, needsApproval),
      execution: this.toExecutionPayload(
        step,
        req,
        needsApproval,
        estimate.approvalAddress,
      ),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Build the payload mobile will sign.
   *
   * Tagged by payload SHAPE rather than namespace so the mobile side can
   * dispatch it through `WalletKitAdapter.submitBridgeExecution` without
   * any shared code branching on a namespace string (CLAUDE.md hard rule,
   * enforced by `pnpm check:chains`). The namespace check below is inside
   * the adapter, which is exactly where §5.2 says provider-shaped
   * knowledge belongs.
   */
  private toExecutionPayload(
    step: LiFiStep,
    req: BridgeQuoteRequest,
    needsApproval: boolean,
    approvalAddress: string | undefined,
  ): BridgeExecutionPayload {
    const txReq = step.transactionRequest;
    if (!txReq) {
      throw new DefiError(
        "network_error",
        "LI.FI step missing transactionRequest",
      );
    }

    const namespace = parseCaip2(req.fromChain)?.namespace;

    if (namespace === "eip155") {
      if (!txReq.to || !txReq.data) {
        throw new DefiError(
          "network_error",
          "LI.FI EVM step missing to/data",
        );
      }
      const spender = approvalAddress ?? txReq.to;
      return {
        kind: "evm_transaction",
        chain: req.fromChain,
        to: txReq.to,
        data: txReq.data,
        value: stringifyBigIntish(txReq.value) ?? "0",
        gasPrice: stringifyBigIntish(txReq.gasPrice),
        gasLimit: stringifyBigIntish(txReq.gasLimit),
        ...(needsApproval
          ? {
              approval: {
                token: caip19ToLifiToken(req.fromAsset) ?? "",
                spender,
                amountRaw: req.amountRaw,
              },
            }
          : {}),
      };
    }

    // Solana and Sui: LI.FI hands back an already-serialised transaction in
    // `data`. The wallet kit deserialises, signs, and submits it.
    if (!txReq.data) {
      throw new DefiError(
        "network_error",
        "LI.FI step missing serialized transaction",
      );
    }
    return {
      kind: "serialized_transaction",
      chain: req.fromChain,
      encoding: "base64",
      payload: txReq.data,
    };
  }

  // ── status ────────────────────────────────────────────────────────────

  async status(ref: BridgeRef): Promise<BridgeStatus> {
    const fromChain = caip2ToLifiChainId(ref.fromChain);
    const toChain = caip2ToLifiChainId(ref.toChain);
    if (fromChain === null || toChain === null) {
      throw new DefiError("unsupported_chain", "chain not routable by LI.FI");
    }

    let res: StatusResponse;
    try {
      res = await getStatus({
        fromChain,
        toChain,
        txHash: ref.sourceTxHash,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[status] LI.FI error: ${detail}`);
      throw new DefiError("network_error", detail);
    }

    return toBridgeStatus(res, {
      fromChain: ref.fromChain,
      toChain: ref.toChain,
      sourceTxHash: ref.sourceTxHash,
    });
  }

  // ── support matrix (§5.3) ─────────────────────────────────────────────

  async listSupportedChains(): Promise<BridgeSupportedChain[]> {
    const chains = await this.getChainsCached();
    const rows: BridgeSupportedChain[] = [];
    for (const chain of chains) {
      const mapped = toSupportedChain(chain);
      if (!mapped) continue;
      // Bitcoin is routable by LI.FI but unsignable by us (no BTC wallet).
      if (this.isBitcoin(mapped.chain)) continue;
      rows.push({ ...mapped, providers: [this.key] });
    }
    return rows;
  }

  async listTools(): Promise<string[]> {
    if (
      this.toolsCache &&
      Date.now() - this.toolsCache.fetchedAt < SUPPORT_TTL_MS
    ) {
      return this.toolsCache.value;
    }
    try {
      const res = await getTools();
      const keys = (res.bridges ?? []).map((b) => b.key);
      this.toolsCache = { value: keys, fetchedAt: Date.now() };
      return keys;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[listTools] LI.FI error: ${detail}`);
      // Stale-while-revalidate: a failed refresh serves the old list rather
      // than claiming we support nothing.
      return this.toolsCache?.value ?? [];
    }
  }

  /**
   * `true` when the last chain fetch failed and we are serving stale data.
   * The controller folds this into `BridgeSupport.degraded` so callers can
   * say "we could not check routes right now" instead of a wrong
   * "unsupported" (§5.3).
   */
  isDegraded(): boolean {
    return (
      this.chainsCache !== null &&
      Date.now() - this.chainsCache.fetchedAt >= SUPPORT_TTL_MS
    );
  }

  private async getChainsCached(): Promise<ExtendedChain[]> {
    const fresh =
      this.chainsCache &&
      Date.now() - this.chainsCache.fetchedAt < SUPPORT_TTL_MS;
    if (fresh) return this.chainsCache!.value;

    if (this.chainsInFlight) return this.chainsInFlight;

    this.chainsInFlight = getChains({
      chainTypes: [
        ChainType.EVM,
        ChainType.SVM,
        ChainType.MVM,
        ChainType.UTXO,
      ],
    })
      .then((chains) => {
        this.chainsCache = { value: chains, fetchedAt: Date.now() };
        return chains;
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[getChains] LI.FI error: ${detail}`);
        // Degrade to the stale list, never to "unsupported" (§5.3).
        if (this.chainsCache) return this.chainsCache.value;
        throw new DefiError("network_error", detail);
      })
      .finally(() => {
        this.chainsInFlight = null;
      });

    return this.chainsInFlight;
  }

  // ── token metadata ────────────────────────────────────────────────────

  async resolveToken(asset: Caip19): Promise<BridgeToken | null> {
    const parsed = parseCaip19(asset);
    if (!parsed) return null;
    const chainId = caip2ToLifiChainId(parsed.chain);
    const tokenId = caip19ToLifiToken(asset);
    if (chainId === null || !tokenId) return null;

    try {
      const token = await getToken(chainId, tokenId);
      return toBridgeToken(parsed.chain, token);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[resolveToken] LI.FI error for ${asset}: ${detail}`);
      return null;
    }
  }

  /**
   * The chain's token list as LI.FI offers it, for a token picker (the
   * optional `listTokens` capability). Most traded first (24h volume;
   * LI.FI's market-cap figures were live-checked 2026-10-09 as unusable,
   * one token claiming ~$4.7 quadrillion), capped, and cached per chain:
   * the list moves slowly and opening a picker must not cost a provider
   * round trip each time. Tokens LI.FI itself flags are left out of the
   * list entirely; a pasted address still resolves through search, where
   * an unvouched token needs the user's confirmation before it signs. A
   * failed refresh serves the last good list rather than an empty picker.
   */
  async listTokens(chain: Caip2): Promise<BridgeToken[]> {
    const chainId = caip2ToLifiChainId(chain);
    if (chainId === null) return [];
    const cached = this.tokenListCache.get(chain);
    if (cached && Date.now() - cached.at < TOKEN_LIST_TTL_MS) {
      return cached.tokens;
    }
    try {
      const response = await getTokens({
        chains: [chainId],
        orderBy: "volumeUSD24H",
        limit: TOKEN_LIST_LIMIT,
      });
      const tokens = (response.tokens[chainId] ?? [])
        .filter((token) => !isLifiFlagged(token))
        .slice(0, TOKEN_LIST_LIMIT)
        .map((token) => toBridgeToken(chain, token));
      this.tokenListCache.set(chain, { at: Date.now(), tokens });
      return tokens;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[listTokens] LI.FI list failed for ${chain}: ${detail}`);
      return cached?.tokens ?? [];
    }
  }

  /**
   * Which tokens LI.FI can actually move between two chains (its
   * `/connections`, live-checked 2026-10-09: Base Sepolia → Arbitrum
   * mainnet has none, Base Sepolia → Arbitrum Sepolia has a handful).
   * Addresses only; metadata comes from `listTokens`. Cached per route.
   * Throws when LI.FI cannot be reached, so callers fail closed.
   */
  private async connections(
    fromId: number,
    toId: number,
  ): Promise<{ from: Set<string>; to: Set<string> }> {
    const key = `${fromId}|${toId}`;
    const cached = this.connectionsCache.get(key);
    if (cached && Date.now() - cached.at < TOKEN_LIST_TTL_MS) return cached;
    // One retry: a single dropped request should not mark the whole
    // picker "couldn't be checked".
    const res = await getConnections({ fromChain: fromId, toChain: toId }).catch(
      () => getConnections({ fromChain: fromId, toChain: toId }),
    );
    const from = new Set<string>();
    const to = new Set<string>();
    for (const c of res.connections ?? []) {
      for (const t of c.fromTokens ?? []) from.add(t.address.toLowerCase());
      for (const t of c.toTokens ?? []) to.add(t.address.toLowerCase());
    }
    const entry = { at: Date.now(), from, to };
    this.connectionsCache.set(key, entry);
    return entry;
  }

  /** Same-asset pairs LI.FI connects from `from` to `to`. */
  async listRoutablePairs(
    from: Caip2,
    to: Caip2,
  ): Promise<Array<{ from: BridgeToken; to: BridgeToken }>> {
    const fromId = caip2ToLifiChainId(from);
    const toId = caip2ToLifiChainId(to);
    if (fromId === null || toId === null || from === to) return [];
    const [links, fromList, toList] = await Promise.all([
      this.connections(fromId as number, toId as number),
      this.listTokens(from),
      this.listTokens(to),
    ]);
    const pairs: Array<{ from: BridgeToken; to: BridgeToken }> = [];
    for (const f of fromList) {
      if (!links.from.has(f.address.toLowerCase())) continue;
      const match = toList.find(
        (t) =>
          t.isNative === f.isNative &&
          t.symbol.toUpperCase() === f.symbol.toUpperCase() &&
          links.to.has(t.address.toLowerCase()),
      );
      if (match) pairs.push({ from: f, to: match });
    }
    return pairs;
  }

  /** Tokens LI.FI can trade on one chain. */
  async listSwapTokens(chain: Caip2): Promise<BridgeToken[]> {
    const id = caip2ToLifiChainId(chain);
    if (id === null) return [];
    const [links, list] = await Promise.all([
      this.connections(id as number, id as number),
      this.listTokens(chain),
    ]);
    return list.filter(
      (t) => links.from.has(t.address.toLowerCase()) && links.to.has(t.address.toLowerCase()),
    );
  }

  /**
   * LI.FI's token lookup accepts a symbol (case-insensitive) or an address
   * per chain. One best match, or none. Live-checked 2026-10-01: `cirBTC`
   * on Arc resolves to Circle's own pinned contract.
   */
  async searchTokens(chain: Caip2, query: string): Promise<BridgeToken[]> {
    const chainId = caip2ToLifiChainId(chain);
    const q = query.trim();
    if (chainId === null || q.length === 0) return [];
    try {
      const token = await getToken(chainId, q);
      return token ? [toBridgeToken(chain, token)] : [];
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.debug?.(`[searchTokens] no LI.FI match for ${q} on ${chain}: ${detail}`);
      return [];
    }
  }

  // ── optional capability: gas top up (§7.5, phase 5) ───────────────────

  /**
   * Route a small slice of the source asset into the destination's gas
   * token via LI.FI's gas-zip bridge.
   *
   * This is a SECOND transaction and appears as its own line in the fee
   * breakdown. It is never silent (§7.5).
   */
  async gasTopUp(req: GasTopUpRequest): Promise<BridgeQuote> {
    const fromChainId = caip2ToLifiChainId(req.fromChain);
    const toChainId = caip2ToLifiChainId(req.chain);
    const fromToken = caip19ToLifiToken(req.fromAsset);
    if (fromChainId === null || toChainId === null || !fromToken) {
      throw new DefiError("unsupported_chain", "gas top up not routable");
    }

    const source = await this.resolveToken(req.fromAsset);
    if (!source) {
      throw new DefiError("unsupported_asset", "gas top up source unknown");
    }
    const amountRaw = usdToRawAmount(req.amountUsd, source);

    const destinationNative = await this.nativeAssetOf(req.chain);
    if (!destinationNative) {
      throw new DefiError("unsupported_chain", "destination native unknown");
    }

    let step: LiFiStep;
    try {
      step = await getQuote({
        fromChain: fromChainId,
        toChain: toChainId,
        fromToken,
        toToken: destinationNative,
        fromAmount: amountRaw,
        fromAddress: req.fromAddress,
        toAddress: req.toAddress,
        integrator: this.integrator,
        allowBridges: [GAS_ZIP_BRIDGE],
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[gasTopUp] LI.FI declined: ${detail}`);
      throw new DefiError("network_error", detail);
    }

    const quote = this.stepToQuote(
      step,
      {
        fromChain: req.fromChain,
        toChain: req.chain,
        fromAsset: req.fromAsset,
        toAsset: `${req.chain}/slip44:60`,
        amountRaw,
        fromAddress: req.fromAddress,
        toAddress: req.toAddress,
        slippageBps: SLIPPAGE_BPS_GAS_TOP_UP,
      },
      SLIPPAGE_BPS_GAS_TOP_UP,
    );

    // Mark the whole thing as a gas top up so the card can render it as an
    // extra line rather than as the main transfer.
    return {
      ...quote,
      fees: quote.fees.map((f) =>
        f.key === "bridge" ? { ...f, key: "gas_top_up", label: "Gas top up" } : f,
      ),
    };
  }

  /**
   * Display name from LI.FI's own chain list, so the mobile card renders a
   * label from DATA instead of deriving one by branching on the namespace
   * (which `pnpm check:chains` forbids in shared UI). Reads the warm cache
   * only: a cold cache returns undefined and the card falls back to the
   * raw CAIP-2 rather than blocking the quote on a chain-list fetch.
   */
  private chainNameFor(chain: Caip2): string | undefined {
    const id = caip2ToLifiChainId(chain);
    if (id === null) return undefined;
    return this.chainsCache?.value.find((c) => c.id === id)?.name;
  }

  private async nativeAssetOf(chain: Caip2): Promise<string | null> {
    const chains: ExtendedChain[] = await this.getChainsCached().catch(
      () => [],
    );
    const id = caip2ToLifiChainId(chain);
    const match = chains.find((c) => c.id === id);
    return match?.nativeToken?.address ?? null;
  }
}

const SLIPPAGE_BPS_GAS_TOP_UP = 500;

function stringifyBigIntish(
  v: string | number | bigint | undefined,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : String(v);
}

/**
 * Convert a USD figure to the source token's smallest unit.
 *
 * Uses the token's OWN decimals, never a constant — the Stellar 7-decimal
 * case in §5.4.1 is precisely the bug this avoids.
 */
function usdToRawAmount(amountUsd: number, token: BridgeToken): string {
  const price = Number.parseFloat(token.priceUsd ?? "0");
  if (!Number.isFinite(price) || price <= 0) {
    throw new DefiError("unsupported_asset", "no price for gas top up source");
  }
  const units = amountUsd / price;
  const scaled = BigInt(Math.round(units * 10 ** token.decimals));
  return scaled.toString();
}

export { lifiChainIdToCaip2 };
