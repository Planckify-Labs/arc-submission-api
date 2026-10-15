/**
 * `circle-cctp` — USDC over Circle CCTP V2, built on Arc App Kit.
 *
 * Spec: docs/bridge-capability-spec.md §2, §5.4, §7.5.1, §7.7.
 *
 * ## Why this adapter exists
 *
 * USDC is the asset this wallet moves most, and CCTP Standard Transfer is
 * FREE at the protocol level. Reaching it through an aggregator adds a
 * spread for nothing (LI.FI charges its own 25 bps on every route), and
 * for Arc it is not even possible: LI.FI lists Arc mainnet but serves no
 * route on it. Circle's App Kit, the SDK Circle's own Arc docs direct
 * builders to for bridging, wraps the whole CCTP lifecycle (approve, burn,
 * attestation, mint) behind one call and reaches every CCTP V2 domain in
 * its chain list, Arc included.
 *
 * The earlier Stellar-only scoping (§10.5) predates this: LI.FI's CCTP
 * reach turned out not to cover Arc, and it takes a fee on the free rail.
 * The registry sorts this adapter ahead of LI.FI for USDC by the existing
 * `supportsAsset` specificity rule, and LI.FI stays as the fallback when
 * this one declines.
 *
 * ## Topology
 *
 *   - Quote HERE, read-only, with App Kit `estimateBridge()`.
 *   - Execute ON THE DEVICE with App Kit `bridge()` and the user's own
 *     signer (mobile `services/bridgeRoutes/adapters/circle/`). The payload
 *     carries parameters, never calldata: App Kit builds the approve and
 *     burn itself against Circle's pinned contracts.
 *   - ALWAYS through Circle's Forwarding Service. Circle submits the
 *     destination mint, so the user needs no destination gas and no
 *     destination signature, and the device can hand off as soon as the
 *     burn is on-chain. That is what makes an on-device App Kit call safe
 *     on a 15-minute Standard transfer: nothing after the burn needs the
 *     phone. The forwarding fee is disclosed on the card (§7.2, §7.5.1).
 *   - Status from Circle's public Iris API (`forwardState`).
 *
 * Sources: EVM (App Kit's Viem adapter) and Solana (App Kit's Solana
 * adapter). Solana is also a DESTINATION: App Kit derives the recipient's
 * USDC token account and asks the Forwarding Service to create it when
 * missing.
 */

import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { DefiError } from "../../../strategies/errors/defi-error";
import { parseCaip19 } from "../../caip";
import type { BridgeRouteAdapter } from "../../registry";
import type {
  BridgeFee,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRef,
  BridgeStatus,
  BridgeSupportedChain,
  BridgeToken,
  Caip2,
  Caip19,
} from "../../types";
import { CircleAppKitClient } from "./app-kit.client";
import {
  type CircleChainDef,
  assetIsToken,
  circleToken,
  decimalStringToRaw,
  explorerLink,
  fetchIrisMessage,
  findCircleChain,
  isStandardAttestationAcceptable,
  rawToDecimalString,
  sourceGasFees,
  standardDurationRange,
  statusFromIrisMessage,
  supportRow,
} from "./circle-route";

/**
 * CCTP moves USDC in six-decimal subunits on every domain this adapter
 * serves ("the amount field in a CCTP message is always in six-decimal
 * subunits", Circle, CCTP on Stellar). Stellar, the one seven-decimal
 * domain, is NOT served here — it has its own adapter.
 */
const USDC_DECIMALS = 6;

/** Quote lifetime. The forwarding fee is quoted dynamically by Circle. */
const QUOTE_TTL_MS = 3 * 60_000;

@Injectable()
export class CircleCctpAdapter implements BridgeRouteAdapter {
  readonly key = "circle-cctp";
  readonly kinds = ["bridge"] as const;

  private readonly logger = new Logger(CircleCctpAdapter.name);

  constructor(private readonly kit: CircleAppKitClient) {}

  // ── capability seam ───────────────────────────────────────────────────

  private route(
    from: Caip2,
    to: Caip2,
  ): { source: CircleChainDef; destination: CircleChainDef } | null {
    if (from === to) return null;
    const chains = this.kit.bridgeChains();
    const source = findCircleChain(chains, from);
    const destination = findCircleChain(chains, to);
    if (!source || !destination) return null;
    // Never bridge between a testnet and a mainnet.
    if (source.isTestnet !== destination.isTestnet) return null;
    // The device signs with App Kit's Viem adapter (EVM) or its Solana
    // adapter (`@circle-fin/adapter-solana`). Any other family has no
    // device signer yet.
    if (source.type !== "evm" && source.type !== "solana") return null;
    if (!source.cctp?.contracts?.v2 || !destination.cctp) return null;
    // Forwarding is what lets the phone hand off after the burn. A
    // destination without it would need a destination signature 15+
    // minutes later, which this adapter deliberately does not attempt.
    if (destination.cctp.forwarderSupported?.destination !== true) return null;
    if (!isStandardAttestationAcceptable(source)) return null;
    if (!source.usdcAddress || !destination.usdcAddress) return null;
    return { source, destination };
  }

  supports(from: Caip2, to: Caip2): boolean {
    return this.route(from, to) !== null;
  }

  /**
   * USDC in, USDC out, both the canonical Circle-issued contract App Kit
   * pins for that chain. Anything else (USDC.e, a bridged wrapper, ETH)
   * is not this adapter's to move.
   */
  supportsAsset(from: Caip19, to: Caip19): boolean {
    const fromChain = parseCaip19(from)?.chain;
    const toChain = parseCaip19(to)?.chain;
    if (!fromChain || !toChain) return false;
    const route = this.route(fromChain, toChain);
    if (!route) return false;
    return (
      assetIsToken(from, route.source, route.source.usdcAddress) &&
      assetIsToken(to, route.destination, route.destination.usdcAddress)
    );
  }

  toProviderChainId(c: Caip2): string | number | null {
    return findCircleChain(this.kit.bridgeChains(), c)?.cctp?.domain ?? null;
  }

  toProviderAsset(a: Caip19): string | null {
    const chain = parseCaip19(a)?.chain;
    if (!chain) return null;
    const def = findCircleChain(this.kit.bridgeChains(), chain);
    return def && assetIsToken(a, def, def.usdcAddress)
      ? (def.usdcAddress ?? null)
      : null;
  }

  // ── quote ─────────────────────────────────────────────────────────────

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const route = this.route(req.fromChain, req.toChain);
    if (!route || !this.supportsAsset(req.fromAsset, req.toAsset)) {
      throw new DefiError(
        "unsupported_chain",
        "circle-cctp does not serve this route",
      );
    }
    const { source, destination } = route;

    let amountRaw: bigint;
    try {
      amountRaw = BigInt(req.amountRaw);
    } catch {
      throw new DefiError("unsupported_asset", "invalid amount");
    }
    if (amountRaw <= 0n) {
      throw new DefiError("unsupported_asset", "amount must be positive");
    }

    let estimate: Awaited<ReturnType<CircleAppKitClient["estimate"]>>;
    try {
      estimate = await this.kit.estimate({
        source,
        destination,
        fromAddress: req.fromAddress,
        recipientAddress: req.toAddress,
        amount: rawToDecimalString(amountRaw, USDC_DECIMALS),
        token: "USDC",
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[quote] estimate failed ${source.chain}->${destination.chain}: ${detail}`,
      );
      throw new DefiError("network_error", "circle estimate unavailable");
    }

    const fromToken = this.usdc(source);
    const toToken = this.usdc(destination);

    // Every USDC-denominated protocol fee comes out of the burned amount
    // (`included: true`). With Standard speed that is the Forwarding
    // Service fee alone; a provider (Fast) fee appears only if App Kit
    // re-priced the speed, and is disclosed rather than hidden.
    const fees: BridgeFee[] = [];
    let maxFeeRaw = 0n;
    for (const fee of estimate.fees) {
      if (!fee.amount || fee.token.toUpperCase() !== "USDC") continue;
      const raw = decimalStringToRaw(fee.amount, USDC_DECIMALS);
      if (raw === 0n) continue;
      maxFeeRaw += raw;
      fees.push({
        key: fee.type === "forwarder" ? "forwarding" : "bridge",
        label: fee.type === "forwarder" ? "Delivery fee" : "Bridge fee",
        amountRaw: raw.toString(),
        token: fromToken,
        included: true,
      });
    }
    fees.push(...sourceGasFees(source, estimate.gasFees));

    // The burn is capped at exactly the fee quoted here (`config.maxFee`
    // on the device), so the floor below is the floor that executes. The
    // Forwarding Service spends any unused headroom as destination
    // priority fee rather than refunding it (Circle, Forwarding Service,
    // "Fees and execution"), so expected and minimum are the same number.
    const toAmountRaw = amountRaw - maxFeeRaw;
    if (toAmountRaw <= 0n) {
      throw new DefiError(
        "unsupported_asset",
        "amount does not cover the delivery fee",
      );
    }

    const durationRange = standardDurationRange(source);
    const issuedAt = new Date();

    return {
      quoteId: randomUUID(),
      provider: this.key,
      kind: "bridge",
      from: {
        chain: req.fromChain,
        chainName: source.name,
        token: fromToken,
        address: req.fromAddress,
        amountRaw: amountRaw.toString(),
      },
      to: {
        chain: req.toChain,
        chainName: destination.name,
        token: toToken,
        address: req.toAddress,
        amountRaw: toAmountRaw.toString(),
      },
      toAmountMinRaw: toAmountRaw.toString(),
      // Burn-and-mint: no pool, no price, nothing to slip.
      slippageBps: 0,
      fees,
      // The user-visible point of CCTP: USDC is native gas asset on Arc, token on other chains (§7.1).
      receivesNativeAsset: toToken.isNative,
      durationSeconds: durationRange[1],
      durationRangeSeconds: durationRange,
      bridge: { key: "cctp", name: "Circle CCTP", mechanism: "burn_mint" },
      steps: [
        {
          key: "approve",
          kind: "approve",
          label: "Approve Circle to move your USDC",
          fromChain: req.fromChain,
        },
        {
          key: "burn",
          kind: "burn",
          label: `Burn USDC on ${source.name}`,
          fromChain: req.fromChain,
          toChain: req.toChain,
        },
        {
          key: "attestation",
          kind: "attestation",
          label: "Wait for Circle to confirm the burn",
          fromChain: req.fromChain,
          toChain: req.toChain,
        },
        {
          key: "mint",
          kind: "mint",
          label: `Circle delivers USDC on ${destination.name}`,
          toChain: req.toChain,
        },
      ],
      execution: {
        kind: "circle_app_kit_bridge",
        chain: req.fromChain,
        protocol: "cctp",
        sourceChain: source.chain,
        destinationChain: destination.chain,
        token: "USDC",
        tokenAddress: source.usdcAddress as string,
        amount: rawToDecimalString(amountRaw, USDC_DECIMALS),
        recipientAddress: req.toAddress,
        transferSpeed: "SLOW",
        useForwarder: true,
        maxFee: rawToDecimalString(maxFeeRaw, USDC_DECIMALS),
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + QUOTE_TTL_MS).toISOString(),
    };
  }

  // ── status ────────────────────────────────────────────────────────────

  async status(ref: BridgeRef): Promise<BridgeStatus> {
    const chains = this.kit.bridgeChains();
    const source = findCircleChain(chains, ref.fromChain);
    if (!source?.cctp) {
      throw new DefiError("unsupported_chain", "unknown circle source");
    }
    const destination = findCircleChain(chains, ref.toChain);

    let message: Awaited<ReturnType<typeof fetchIrisMessage>>;
    try {
      message = await fetchIrisMessage({
        domain: source.cctp.domain,
        isTestnet: source.isTestnet,
        txHash: ref.sourceTxHash,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[status] iris unavailable: ${detail}`);
      throw new DefiError("network_error", detail);
    }

    return statusFromIrisMessage({
      message,
      sourceTxHash: ref.sourceTxHash,
      burnStepKey: "burn",
      mintStepKey: "mint",
      explorerUrlFor: (hash) => explorerLink(destination, hash),
    });
  }

  // ── support matrix ────────────────────────────────────────────────────

  async listSupportedChains(): Promise<BridgeSupportedChain[]> {
    return this.kit
      .bridgeChains()
      .filter((def) => def.usdcAddress && def.cctp)
      .map((def) => supportRow(def, this.key))
      .filter((row): row is BridgeSupportedChain => row !== null);
  }

  async listTools(): Promise<string[]> {
    return [];
  }

  /** USDC to USDC, wherever this adapter has a route (App Kit's pins). */
  async listRoutablePairs(
    from: Caip2,
    to: Caip2,
  ): Promise<Array<{ from: BridgeToken; to: BridgeToken }>> {
    const route = this.route(from, to);
    if (!route) return [];
    return [
      { from: this.usdc(route.source), to: this.usdc(route.destination) },
    ];
  }

  async resolveToken(asset: Caip19): Promise<BridgeToken | null> {
    const chain = parseCaip19(asset)?.chain;
    if (!chain) return null;
    const def = findCircleChain(this.kit.bridgeChains(), chain);
    if (!def || !assetIsToken(asset, def, def.usdcAddress)) return null;
    return this.usdc(def);
  }

  private usdc(def: CircleChainDef): BridgeToken {
    return circleToken({
      def,
      address: def.usdcAddress as string,
      symbol: "USDC",
      name: "USD Coin",
      decimals: USDC_DECIMALS,
    });
  }

  /**
   * Deliberately NO `gasTopUp`: the Forwarding Service pays the
   * destination leg, so there is no receive-side strand risk to top up
   * against. The absence is the signal (§5.2, §7.5.1).
   */
}
