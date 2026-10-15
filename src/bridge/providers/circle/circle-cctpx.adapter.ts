/**
 * `circle-cctpx` — EURC over Circle's CCTP for non-USDC assets ("CCTPx"),
 * built on Arc App Kit.
 *
 * Spec: docs/bridge-capability-spec.md §2 (superseded note).
 *
 * ## A different product from `circle-cctp`, so a different adapter
 *
 * EURC does not move through `TokenMessengerV2`. It moves through
 * `CrossChainTokenService` (Circle, `/cctp/expanded-assets`), and nearly
 * everything that matters differs from USDC:
 *
 * |                | USDC (`circle-cctp`)         | EURC (this adapter)                   |
 * |----------------|------------------------------|---------------------------------------|
 * | Fee            | deducted from the amount     | paid ON TOP, in the source NATIVE gas |
 * | Approval       | USDC → TokenMessengerV2      | token → per-token TokenManager        |
 * | Quote          | fee API                      | Iris SIGNED quote, passed back as-is  |
 * | Forwarding     | opt-in                       | always (App Kit forces it)            |
 * | Chains         | every CCTP V2 domain         | the chains App Kit marks `cctpx`      |
 *
 * So this is its own adapter, never an `if (symbol === "EURC")` inside the
 * USDC one. What the two share is helpers (`circle-route.ts`), not
 * control flow.
 *
 * App Kit (`bridge({ token: "EURC" })`) resolves the registration, the
 * TokenManager and the signed fee quote itself, which is exactly the
 * orchestration Circle's docs send builders to App Kit for. Custom fees
 * are unsupported on CCTPx either way, and we set none.
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
  nativeToken,
  rawToDecimalString,
  sourceGasFees,
  standardDurationRange,
  statusFromIrisMessage,
  supportRow,
} from "./circle-route";

/** EURC is six decimals on every chain CCTPx serves (all EVM). */
const EURC_DECIMALS = 6;

const QUOTE_TTL_MS = 3 * 60_000;

/**
 * Margin kept between our card's expiry and the signed quote's own
 * expiry, so a user who approves at the last second never submits a
 * quote App Kit then has to replace with a different fee.
 */
const SIGNED_QUOTE_SAFETY_MS = 20_000;

@Injectable()
export class CircleCctpxAdapter implements BridgeRouteAdapter {
  readonly key = "circle-cctpx";
  readonly kinds = ["bridge"] as const;

  private readonly logger = new Logger(CircleCctpxAdapter.name);

  constructor(private readonly kit: CircleAppKitClient) {}

  private route(
    from: Caip2,
    to: Caip2,
  ): { source: CircleChainDef; destination: CircleChainDef } | null {
    if (from === to) return null;
    const chains = this.kit.bridgeChains();
    const source = findCircleChain(chains, from);
    const destination = findCircleChain(chains, to);
    if (!source || !destination) return null;
    if (source.isTestnet !== destination.isTestnet) return null;
    // CCTPx reach is App Kit's `cctpx` marker, not a list of ours.
    if (!source.cctpx || !destination.cctpx) return null;
    if (source.type !== "evm") return null;
    if (!isStandardAttestationAcceptable(source)) return null;
    if (!source.eurcAddress || !destination.eurcAddress) return null;
    return { source, destination };
  }

  supports(from: Caip2, to: Caip2): boolean {
    return this.route(from, to) !== null;
  }

  supportsAsset(from: Caip19, to: Caip19): boolean {
    const fromChain = parseCaip19(from)?.chain;
    const toChain = parseCaip19(to)?.chain;
    if (!fromChain || !toChain) return false;
    const route = this.route(fromChain, toChain);
    if (!route) return false;
    return (
      assetIsToken(from, route.source, route.source.eurcAddress) &&
      assetIsToken(to, route.destination, route.destination.eurcAddress)
    );
  }

  toProviderChainId(c: Caip2): string | number | null {
    return findCircleChain(this.kit.bridgeChains(), c)?.cctp?.domain ?? null;
  }

  toProviderAsset(a: Caip19): string | null {
    const chain = parseCaip19(a)?.chain;
    if (!chain) return null;
    const def = findCircleChain(this.kit.bridgeChains(), chain);
    return def && assetIsToken(a, def, def.eurcAddress)
      ? (def.eurcAddress ?? null)
      : null;
  }

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const route = this.route(req.fromChain, req.toChain);
    if (!route || !this.supportsAsset(req.fromAsset, req.toAsset)) {
      throw new DefiError(
        "unsupported_chain",
        "circle-cctpx does not serve this route",
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
        amount: rawToDecimalString(amountRaw, EURC_DECIMALS),
        token: "EURC",
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[quote] estimate failed ${source.chain}->${destination.chain}: ${detail}`,
      );
      throw new DefiError("network_error", "circle estimate unavailable");
    }

    // A CCTPx route without a signed quote cannot promise its fee.
    if (estimate.quote === undefined) {
      throw new DefiError(
        "network_error",
        "circle cctpx returned no signed quote",
      );
    }

    // The protocol fee (forwarding included) is charged ON TOP, in the
    // source chain's NATIVE token, as `msg.value` on the transfer. It is
    // not deducted from the EURC, so `included: false`.
    const gas = nativeToken(source);
    const fees: BridgeFee[] = [];
    for (const fee of estimate.fees) {
      if (!fee.amount) continue;
      let raw: bigint;
      try {
        raw = decimalStringToRaw(fee.amount, gas.decimals);
      } catch {
        continue;
      }
      if (raw === 0n) continue;
      fees.push({
        key: "forwarding",
        label: "Delivery fee",
        amountRaw: raw.toString(),
        token: gas,
        included: false,
      });
    }
    fees.push(...sourceGasFees(source, estimate.gasFees));

    const fromToken = this.eurc(source);
    const toToken = this.eurc(destination);
    const durationRange = standardDurationRange(source);

    const issuedAt = new Date();
    const ourExpiry = issuedAt.getTime() + QUOTE_TTL_MS;
    const expiresAtMs =
      estimate.quoteExpiresAtMs !== undefined
        ? Math.min(
            ourExpiry,
            estimate.quoteExpiresAtMs - SIGNED_QUOTE_SAFETY_MS,
          )
        : ourExpiry;
    if (expiresAtMs <= issuedAt.getTime()) {
      throw new DefiError(
        "quote_expired",
        "circle cctpx quote already expiring",
      );
    }

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
        // The fee is paid in native gas, so the full amount arrives.
        amountRaw: amountRaw.toString(),
      },
      toAmountMinRaw: amountRaw.toString(),
      slippageBps: 0,
      fees,
      receivesNativeAsset: toToken.isNative,
      durationSeconds: durationRange[1],
      durationRangeSeconds: durationRange,
      bridge: { key: "cctpx", name: "Circle CCTP", mechanism: "burn_mint" },
      steps: [
        {
          key: "approve",
          kind: "approve",
          label: "Approve Circle to move your EURC",
          fromChain: req.fromChain,
        },
        {
          key: "transfer",
          kind: "burn",
          label: `Send EURC from ${source.name}`,
          fromChain: req.fromChain,
          toChain: req.toChain,
        },
        {
          key: "attestation",
          kind: "attestation",
          label: "Wait for Circle to confirm the transfer",
          fromChain: req.fromChain,
          toChain: req.toChain,
        },
        {
          key: "forward",
          kind: "mint",
          label: `Circle delivers EURC on ${destination.name}`,
          toChain: req.toChain,
        },
      ],
      execution: {
        kind: "circle_app_kit_bridge",
        chain: req.fromChain,
        protocol: "cctpx",
        sourceChain: source.chain,
        destinationChain: destination.chain,
        token: "EURC",
        tokenAddress: source.eurcAddress as string,
        amount: rawToDecimalString(amountRaw, EURC_DECIMALS),
        recipientAddress: req.toAddress,
        transferSpeed: "SLOW",
        useForwarder: true,
        quote: estimate.quote,
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

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
      burnStepKey: "transfer",
      mintStepKey: "forward",
      explorerUrlFor: (hash) => explorerLink(destination, hash),
    });
  }

  async listSupportedChains(): Promise<BridgeSupportedChain[]> {
    return this.kit
      .bridgeChains()
      .filter((def) => def.cctpx && def.eurcAddress)
      .map((def) => supportRow(def, this.key))
      .filter((row): row is BridgeSupportedChain => row !== null);
  }

  async listTools(): Promise<string[]> {
    return [];
  }

  /** EURC to EURC, wherever this adapter has a route (App Kit's pins). */
  async listRoutablePairs(
    from: Caip2,
    to: Caip2,
  ): Promise<Array<{ from: BridgeToken; to: BridgeToken }>> {
    const route = this.route(from, to);
    if (!route) return [];
    return [
      { from: this.eurc(route.source), to: this.eurc(route.destination) },
    ];
  }

  async resolveToken(asset: Caip19): Promise<BridgeToken | null> {
    const chain = parseCaip19(asset)?.chain;
    if (!chain) return null;
    const def = findCircleChain(this.kit.bridgeChains(), chain);
    if (!def || !assetIsToken(asset, def, def.eurcAddress)) return null;
    return this.eurc(def);
  }

  private eurc(def: CircleChainDef): BridgeToken {
    return circleToken({
      def,
      address: def.eurcAddress as string,
      symbol: "EURC",
      name: "Euro Coin",
      decimals: EURC_DECIMALS,
    });
  }
}
