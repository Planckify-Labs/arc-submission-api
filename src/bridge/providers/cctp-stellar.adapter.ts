/**
 * `cctp` — Circle CCTP V2 for routes touching STELLAR, both directions.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §5.4.1, §10.5, §10.6.
 *
 * ## Why this adapter exists
 *
 * Stellar is absent from LI.FI entirely (§3.2), and Arc App Kit (the
 * `circle-cctp` adapter) does not reach Stellar either: App Kit's bridge
 * chain list is EVM + Solana. CCTP reaches Stellar directly as domain 27,
 * so this adapter makes raw contract calls. The EVM-side facts (domain,
 * USDC, `TokenMessengerV2`, forwarding support) come from App Kit's chain
 * definitions, so there is one Circle-sourced table, not two.
 *
 * ## EVM → Stellar
 *
 * `depositForBurnWithHook` on the EVM source, with BOTH `mintRecipient`
 * and `destinationCaller` set to the pinned `CctpForwarder` and the real
 * recipient in the hook (`stellar-burn-params.ts`, unconstructible if
 * wrong). Stellar has NO Forwarding Service, so once Circle attests the
 * burn, somebody must call `CctpForwarder.mint_and_forward(message,
 * attestation)` on Stellar. That is the recipient's own wallet: `status()`
 * returns the invocation as `destinationAction` once the burn is attested
 * and the nonce is still unused, and the transfer is `completed` only
 * when the MessageTransmitter reports the nonce used — never merely on
 * attestation.
 *
 * ## Stellar → EVM
 *
 * `TokenMessengerMinter.deposit_for_burn_with_hook` on Soroban (argument
 * layout read from the deployed contract's own spec), carrying Circle's
 * Forwarding Service hook so Circle submits the EVM mint. Only EVM
 * destinations with Forwarding Service support are offered.
 *
 * ## Mainnet gate
 *
 * Both directions stay behind `isStellarCctpEnabled` until the §10.6
 * testnet dry-run signs them off.
 */

import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { encodeFunctionData } from "viem";
import { DefiError } from "../../strategies/errors/defi-error";
import { buildCaip19, parseCaip2, parseCaip19 } from "../caip";
import type { BridgeRouteAdapter } from "../registry";
import type {
  BridgeExecutionPayload,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRef,
  BridgeStatus,
  BridgeSupportedChain,
  BridgeToken,
  Caip2,
  Caip19,
} from "../types";
import {
  CctpParamError,
  EVM_USDC_DECIMALS,
  STELLAR_CCTP_CONTRACTS,
  STELLAR_CCTP_DOMAIN,
  STELLAR_USDC_ASSET,
  STELLAR_USDC_DECIMALS,
  type StellarCctpNetwork,
  buildMintAndForwardInvocation,
  buildStellarBurnParams,
  buildStellarSourceBurn,
  isStellarCctpEnabled,
  sourceUsdcToStellarUnits,
} from "./cctp/stellar-burn-params";
import { CircleAppKitClient } from "./circle/app-kit.client";
import {
  type CircleChainDef,
  type IrisMessage,
  assetIsToken,
  circleToken,
  explorerLink,
  fetchIrisMessage,
  findCircleChain,
  irisBaseUrl,
  isStandardAttestationAcceptable,
  standardDurationRange,
  statusFromIrisMessage,
  supportRow,
} from "./circle/circle-route";

const DEPOSIT_FOR_BURN_WITH_HOOK_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Standard transfers carry no protocol fee, and Stellar has no forwarding. */
const STANDARD_MAX_FEE_RAW = 0n;

const QUOTE_TTL_MS = 5 * 60_000;

const NETWORK_PASSPHRASE: Record<StellarCctpNetwork, string> = {
  pubnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

/**
 * Soroban RPC for the read-only nonce check. Configurable because SDF runs
 * no public mainnet RPC; the defaults are public endpoints verified to
 * serve `simulateTransaction` against these contracts on 2026-09-26.
 */
function sorobanRpcUrl(network: StellarCctpNetwork): string {
  return network === "pubnet"
    ? (process.env.STELLAR_SOROBAN_RPC_URL_PUBNET ??
        "https://mainnet.sorobanrpc.com")
    : (process.env.STELLAR_SOROBAN_RPC_URL_TESTNET ??
        "https://soroban-testnet.stellar.org");
}

type Direction =
  | { kind: "inbound"; network: StellarCctpNetwork; evm: CircleChainDef }
  | { kind: "outbound"; network: StellarCctpNetwork; evm: CircleChainDef };

@Injectable()
export class CctpStellarAdapter implements BridgeRouteAdapter {
  readonly key = "cctp";
  readonly kinds = ["bridge"] as const;

  private readonly logger = new Logger(CctpStellarAdapter.name);

  constructor(private readonly circle: CircleAppKitClient) {}

  // ── capability seam ───────────────────────────────────────────────────

  private stellarNetworkOf(chain: Caip2): StellarCctpNetwork | null {
    const parsed = parseCaip2(chain);
    if (parsed?.namespace !== "stellar") return null;
    // CAIP-28 references are `pubnet` / `testnet`, NOT `mainnet`.
    if (parsed.reference === "pubnet") return "pubnet";
    if (parsed.reference === "testnet") return "testnet";
    return null;
  }

  /** The EVM counterpart, from App Kit's chain definitions. */
  private evmSide(
    chain: Caip2,
    network: StellarCctpNetwork,
  ): CircleChainDef | null {
    const def = findCircleChain(this.circle.bridgeChains(), chain);
    if (!def || def.type !== "evm") return null;
    // Never pair a Stellar testnet with an EVM mainnet, or vice versa.
    if (def.isTestnet !== (network === "testnet")) return null;
    if (!def.cctp?.contracts?.v2 || !def.usdcAddress) return null;
    return def;
  }

  private direction(from: Caip2, to: Caip2): Direction | null {
    const toStellar = this.stellarNetworkOf(to);
    const fromStellar = this.stellarNetworkOf(from);

    if (toStellar && !fromStellar) {
      if (!isStellarCctpEnabled(toStellar)) return null;
      const evm = this.evmSide(from, toStellar);
      if (!evm?.cctp?.contracts?.v2?.tokenMessenger) return null;
      if (!isStandardAttestationAcceptable(evm)) return null;
      return { kind: "inbound", network: toStellar, evm };
    }

    if (fromStellar && !toStellar) {
      if (!isStellarCctpEnabled(fromStellar)) return null;
      const evm = this.evmSide(to, fromStellar);
      // Circle submits the EVM mint, so the destination must support it.
      if (evm?.cctp?.forwarderSupported?.destination !== true) return null;
      return { kind: "outbound", network: fromStellar, evm };
    }

    return null;
  }

  supports(from: Caip2, to: Caip2): boolean {
    return this.direction(from, to) !== null;
  }

  /**
   * CCTP is burn-and-mint: it needs the token ISSUER's mint authority on
   * the destination, so this is USDC only. `ETH → Stellar` falls through
   * to the no-route state (§7.6) rather than failing mid-flight.
   */
  supportsAsset(from: Caip19, to: Caip19): boolean {
    const fromChain = parseCaip19(from)?.chain;
    const toChain = parseCaip19(to)?.chain;
    if (!fromChain || !toChain) return false;
    const dir = this.direction(fromChain, toChain);
    if (!dir) return false;
    const [evmAsset, stellarAsset] =
      dir.kind === "inbound" ? [from, to] : [to, from];
    return (
      assetIsToken(evmAsset, dir.evm, dir.evm.usdcAddress) &&
      this.isStellarUsdc(stellarAsset, dir.network)
    );
  }

  private isStellarUsdc(asset: Caip19, network: StellarCctpNetwork): boolean {
    const parsed = parseCaip19(asset);
    if (!parsed || parsed.chain !== `stellar:${network}`) return false;
    // Strkeys are case-SENSITIVE; compare verbatim, in the CAIP-19 hyphen
    // form (`CODE-ISSUER`, see `stellarUsdcToken`).
    return (
      parsed.assetReference === STELLAR_USDC_ASSET[network].replace(":", "-")
    );
  }

  toProviderChainId(c: Caip2): string | number | null {
    if (this.stellarNetworkOf(c)) return STELLAR_CCTP_DOMAIN;
    return findCircleChain(this.circle.bridgeChains(), c)?.cctp?.domain ?? null;
  }

  toProviderAsset(a: Caip19): string | null {
    const parsed = parseCaip19(a);
    if (!parsed) return null;
    const network = this.stellarNetworkOf(parsed.chain);
    if (network) {
      return this.isStellarUsdc(a, network)
        ? STELLAR_USDC_ASSET[network]
        : null;
    }
    const def = findCircleChain(this.circle.bridgeChains(), parsed.chain);
    return def && assetIsToken(a, def, def.usdcAddress)
      ? (def.usdcAddress ?? null)
      : null;
  }

  // ── quote ─────────────────────────────────────────────────────────────

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const dir = this.direction(req.fromChain, req.toChain);
    if (!dir) {
      // Includes a mainnet route while the gate is closed (§10.6).
      throw new DefiError(
        "unsupported_chain",
        "cctp stellar route not enabled",
      );
    }
    if (!this.supportsAsset(req.fromAsset, req.toAsset)) {
      throw new DefiError("unsupported_asset", "cctp bridges USDC only");
    }
    let amountRaw: bigint;
    try {
      amountRaw = BigInt(req.amountRaw);
    } catch {
      throw new DefiError("unsupported_asset", "invalid amount");
    }

    try {
      return dir.kind === "inbound"
        ? this.quoteInbound(req, dir, amountRaw)
        : await this.quoteOutbound(req, dir, amountRaw);
    } catch (error: unknown) {
      if (error instanceof CctpParamError) {
        this.logger.warn(`[quote] params rejected: ${error.message}`);
        throw new DefiError("unsupported_asset", error.message);
      }
      throw error;
    }
  }

  /** EVM → Stellar. */
  private quoteInbound(
    req: BridgeQuoteRequest,
    dir: Extract<Direction, { kind: "inbound" }>,
    amountRaw: bigint,
  ): BridgeQuote {
    const usdc = dir.evm.usdcAddress as `0x${string}`;
    const params = buildStellarBurnParams({
      network: dir.network,
      amountRaw,
      burnToken: usdc,
      recipientStrkey: req.toAddress,
      maxFeeRaw: STANDARD_MAX_FEE_RAW,
    });

    const fromToken = this.evmUsdc(dir.evm);
    const toToken = this.stellarUsdcToken(dir.network);
    // Burn-and-mint is 1:1. The only transformation is the 6→7 decimal
    // rescale, from token metadata rather than a shared constant (§6).
    const toAmountRaw = sourceUsdcToStellarUnits(amountRaw).toString();
    const duration = standardDurationRange(dir.evm);
    const stellarName =
      dir.network === "pubnet" ? "Stellar" : "Stellar Testnet";
    const issuedAt = new Date();

    return {
      quoteId: randomUUID(),
      provider: this.key,
      from: {
        chain: req.fromChain,
        chainName: dir.evm.name,
        token: fromToken,
        address: req.fromAddress,
        amountRaw: req.amountRaw,
      },
      to: {
        chain: req.toChain,
        chainName: stellarName,
        token: toToken,
        address: req.toAddress,
        amountRaw: toAmountRaw,
      },
      toAmountMinRaw: toAmountRaw,
      kind: "bridge",
      slippageBps: 0,
      fees: [
        {
          key: "bridge",
          label: "Bridge fee",
          amountRaw: "0",
          token: fromToken,
          included: true,
        },
      ],
      receivesNativeAsset: toToken.isNative,
      durationSeconds: duration[1],
      durationRangeSeconds: duration,
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
          label: `Burn USDC on ${dir.evm.name}`,
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
          // Stellar has no Forwarding Service: the user's own Stellar
          // wallet claims the mint once Circle attests (§5.4.1).
          label: "Receive USDC on Stellar with your wallet",
          toChain: req.toChain,
        },
      ],
      execution: this.toEvmBurnTransaction(req.fromChain, dir.evm, params),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + QUOTE_TTL_MS).toISOString(),
    };
  }

  private toEvmBurnTransaction(
    fromChain: Caip2,
    evm: CircleChainDef,
    params: ReturnType<typeof buildStellarBurnParams>,
  ): BridgeExecutionPayload {
    const tokenMessenger = evm.cctp?.contracts?.v2?.tokenMessenger as string;
    const data = encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_WITH_HOOK_ABI,
      functionName: "depositForBurnWithHook",
      args: [
        params.amountRaw,
        params.destinationDomain,
        params.mintRecipient,
        params.burnToken,
        params.destinationCaller,
        params.maxFeeRaw,
        params.minFinalityThreshold,
        params.hookData,
      ],
    });
    return {
      kind: "evm_transaction",
      chain: fromChain,
      to: tokenMessenger,
      data,
      value: "0",
      approval: {
        token: params.burnToken,
        spender: tokenMessenger,
        amountRaw: params.amountRaw.toString(),
      },
    };
  }

  /** Stellar → EVM. */
  private async quoteOutbound(
    req: BridgeQuoteRequest,
    dir: Extract<Direction, { kind: "outbound" }>,
    amountRaw: bigint,
  ): Promise<BridgeQuote> {
    const destinationDomain = dir.evm.cctp?.domain as number;
    const forwardFeeRaw6 = await this.fetchForwardFee(
      destinationDomain,
      dir.network === "testnet",
    );
    const burn = buildStellarSourceBurn({
      network: dir.network,
      callerStrkey: req.fromAddress,
      amountRaw,
      destinationDomain,
      mintRecipientEvm: req.toAddress,
      maxFeeRaw6: forwardFeeRaw6,
    });

    const fromToken = this.stellarUsdcToken(dir.network);
    const toToken = this.evmUsdc(dir.evm);
    const toAmountRaw = (burn.messageAmountRaw6 - burn.maxFeeRaw6).toString();
    const duration = standardDurationRange({
      // Stellar attests in ~5 s; the CircleChainDef shape just carries the domain.
      ...dir.evm,
      cctp: { domain: STELLAR_CCTP_DOMAIN },
    });
    const stellarName =
      dir.network === "pubnet" ? "Stellar" : "Stellar Testnet";
    const issuedAt = new Date();

    return {
      quoteId: randomUUID(),
      provider: this.key,
      from: {
        chain: req.fromChain,
        chainName: stellarName,
        token: fromToken,
        address: req.fromAddress,
        // What actually leaves the account: CCTP burns only through the
        // sixth decimal, so a seventh-decimal remainder is never shown as
        // sent (Circle, "Stellar as the source").
        amountRaw: burn.burnedRaw7.toString(),
      },
      to: {
        chain: req.toChain,
        chainName: dir.evm.name,
        token: toToken,
        address: req.toAddress,
        amountRaw: toAmountRaw,
      },
      // The burn caps the fee at exactly the quoted forwarding fee, and
      // Circle spends any headroom as destination priority fee, so the
      // floor is the expected amount.
      toAmountMinRaw: toAmountRaw,
      kind: "bridge",
      slippageBps: 0,
      fees: [
        {
          key: "forwarding",
          label: "Delivery fee",
          amountRaw: sourceUsdcToStellarUnits(burn.maxFeeRaw6).toString(),
          token: fromToken,
          included: true,
        },
      ],
      receivesNativeAsset: toToken.isNative,
      durationSeconds: duration[1],
      durationRangeSeconds: duration,
      bridge: { key: "cctp", name: "Circle CCTP", mechanism: "burn_mint" },
      steps: [
        {
          // Soroban SEP-41 allowance: the TokenMessengerMinter pulls the
          // burn with `transfer_from`.
          key: "approve",
          kind: "approve",
          label: "Approve Circle to move your USDC",
          fromChain: req.fromChain,
        },
        {
          key: "burn",
          kind: "burn",
          label: "Burn USDC on Stellar",
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
          label: `Circle delivers USDC on ${dir.evm.name}`,
          toChain: req.toChain,
        },
      ],
      execution: {
        kind: "soroban_invoke",
        chain: req.fromChain,
        contractId: burn.contractId,
        method: burn.method,
        argsXdrBase64: [...burn.argsXdrBase64],
        approval: {
          token: burn.approval.token,
          spender: burn.approval.spender,
          amountRaw: burn.approval.amountRaw.toString(),
        },
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + QUOTE_TTL_MS).toISOString(),
    };
  }

  /**
   * Circle's Forwarding Service fee for Stellar → `destinationDomain`, in
   * six-decimal USDC subunits. `high` tier at Standard finality, the same
   * choice App Kit makes for its own forwarded burns.
   */
  private async fetchForwardFee(
    destinationDomain: number,
    isTestnet: boolean,
  ): Promise<bigint> {
    const url = `${irisBaseUrl(isTestnet)}/v2/burn/USDC/fees/${STELLAR_CCTP_DOMAIN}/${destinationDomain}?forward=true`;
    let tiers: Array<{
      finalityThreshold?: number;
      forwardFee?: { high?: number };
    }>;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`iris ${res.status}`);
      tiers = (await res.json()) as typeof tiers;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[fee] iris forward fee unavailable: ${detail}`);
      throw new DefiError("network_error", "forwarding fee unavailable");
    }
    const high = tiers.find((t) => t.finalityThreshold === 2000)?.forwardFee
      ?.high;
    if (typeof high !== "number" || !Number.isInteger(high) || high < 0) {
      throw new DefiError("network_error", "forwarding fee missing");
    }
    return BigInt(high);
  }

  // ── status ────────────────────────────────────────────────────────────

  /**
   * CCTP produces only `completed` or `failed`: burn-and-mint is atomic
   * per message (§7.7.1).
   */
  async status(ref: BridgeRef): Promise<BridgeStatus> {
    const fromStellar = this.stellarNetworkOf(ref.fromChain);
    if (fromStellar) return this.statusOutbound(ref, fromStellar);
    const toStellar = this.stellarNetworkOf(ref.toChain);
    if (toStellar) return this.statusInbound(ref, toStellar);
    throw new DefiError("unsupported_chain", "not a stellar cctp route");
  }

  private async iris(
    domain: number,
    isTestnet: boolean,
    txHash: string,
  ): Promise<IrisMessage | undefined> {
    try {
      return await fetchIrisMessage({ domain, isTestnet, txHash });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[status] iris unreachable: ${detail}`);
      throw new DefiError("network_error", detail);
    }
  }

  private async statusOutbound(
    ref: BridgeRef,
    network: StellarCctpNetwork,
  ): Promise<BridgeStatus> {
    const destination = findCircleChain(
      this.circle.bridgeChains(),
      ref.toChain,
    );
    // Stellar tx hashes are 64 hex chars without a prefix.
    const message = await this.iris(
      STELLAR_CCTP_DOMAIN,
      network === "testnet",
      ref.sourceTxHash,
    );
    return statusFromIrisMessage({
      message,
      sourceTxHash: ref.sourceTxHash,
      burnStepKey: "burn",
      mintStepKey: "mint",
      explorerUrlFor: (hash) => explorerLink(destination, hash),
    });
  }

  private async statusInbound(
    ref: BridgeRef,
    network: StellarCctpNetwork,
  ): Promise<BridgeStatus> {
    const source = this.evmSide(ref.fromChain, network);
    if (!source?.cctp) {
      throw new DefiError("unsupported_chain", "unknown cctp source");
    }
    const message = await this.iris(
      source.cctp.domain,
      source.isTestnet,
      ref.sourceTxHash,
    );

    const attested =
      message?.status === "complete" &&
      typeof message.attestation === "string" &&
      message.attestation.startsWith("0x") &&
      typeof message.message === "string" &&
      message.message.startsWith("0x");
    if (!message || !attested) {
      return {
        outcome: null,
        phase: message ? "pending_attestation" : "pending_source",
        currentStepKey: message ? "attestation" : "burn",
        sourceTxHash: ref.sourceTxHash,
      };
    }

    // Attested is NOT delivered: Stellar has no Forwarding Service, so the
    // mint happens only when `mint_and_forward` runs. The nonce comes from
    // the attested message itself (header bytes 12..44), and "used" is
    // the MessageTransmitter's own answer, not an inference.
    const nonceHex = this.nonceFromMessage(message.message as string);
    let used: boolean;
    try {
      used = await this.isNonceUsed(network, nonceHex);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[status] soroban nonce check failed: ${detail}`);
      throw new DefiError("network_error", "stellar status unavailable");
    }

    if (used) {
      return {
        outcome: "completed",
        phase: "settled",
        currentStepKey: "mint",
        sourceTxHash: ref.sourceTxHash,
      };
    }

    const claim = buildMintAndForwardInvocation({
      network,
      messageHex: message.message as string,
      attestationHex: message.attestation as string,
    });
    return {
      outcome: null,
      phase: "pending_destination",
      currentStepKey: "mint",
      sourceTxHash: ref.sourceTxHash,
      destinationAction: {
        kind: "soroban_invoke",
        chain: ref.toChain,
        contractId: claim.contractId,
        method: claim.method,
        argsXdrBase64: [...claim.argsXdrBase64],
      },
    };
  }

  /** CCTP V2 message header: version(4) src(4) dst(4) nonce(32) … */
  private nonceFromMessage(messageHex: string): string {
    const body = messageHex.slice(2);
    if (body.length < 88)
      throw new DefiError("network_error", "cctp message too short");
    return body.slice(24, 88);
  }

  private async isNonceUsed(
    network: StellarCctpNetwork,
    nonceHex: string,
  ): Promise<boolean> {
    const server = new rpc.Server(sorobanRpcUrl(network));
    // Simulation only: a throwaway source that never exists on-ledger and
    // never signs. Nothing is submitted.
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE[network],
    })
      .addOperation(
        new Contract(STELLAR_CCTP_CONTRACTS[network].messageTransmitter).call(
          "is_nonce_used",
          xdr.ScVal.scvBytes(Buffer.from(nonceHex, "hex")),
        ),
      )
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result) {
      throw new Error("simulation failed");
    }
    return scValToNative(sim.result.retval) === true;
  }

  // ── support matrix ────────────────────────────────────────────────────

  async listSupportedChains(): Promise<BridgeSupportedChain[]> {
    const rows: BridgeSupportedChain[] = [];
    for (const network of ["pubnet", "testnet"] as StellarCctpNetwork[]) {
      if (!isStellarCctpEnabled(network)) continue;
      rows.push({
        chain: `stellar:${network}`,
        name: network === "pubnet" ? "Stellar" : "Stellar Testnet",
        providers: [this.key],
        nativeSymbol: "XLM",
      });
      // Only advertise EVM counterparts when that Stellar side is open.
      for (const def of this.circle.bridgeChains()) {
        if (def.type !== "evm" || def.isTestnet !== (network === "testnet"))
          continue;
        if (!def.usdcAddress || !def.cctp?.contracts?.v2) continue;
        const row = supportRow(def, this.key);
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  async listTools(): Promise<string[]> {
    return [];
  }

  /** USDC between an EVM chain and Stellar, in the direction asked. */
  async listRoutablePairs(
    from: Caip2,
    to: Caip2,
  ): Promise<Array<{ from: BridgeToken; to: BridgeToken }>> {
    const dir = this.direction(from, to);
    if (!dir) return [];
    const evm = this.evmUsdc(dir.evm);
    const stellar = this.stellarUsdcToken(dir.network);
    return dir.kind === "inbound"
      ? [{ from: evm, to: stellar }]
      : [{ from: stellar, to: evm }];
  }

  async resolveToken(asset: Caip19): Promise<BridgeToken | null> {
    const parsed = parseCaip19(asset);
    if (!parsed) return null;
    const network = this.stellarNetworkOf(parsed.chain);
    if (network) {
      return this.isStellarUsdc(asset, network)
        ? this.stellarUsdcToken(network)
        : null;
    }
    const def = findCircleChain(this.circle.bridgeChains(), parsed.chain);
    return def && assetIsToken(asset, def, def.usdcAddress)
      ? this.evmUsdc(def)
      : null;
  }

  private evmUsdc(def: CircleChainDef): BridgeToken {
    return circleToken({
      def,
      address: def.usdcAddress as string,
      symbol: "USDC",
      name: "USD Coin",
      decimals: EVM_USDC_DECIMALS,
    });
  }

  private stellarUsdcToken(network: StellarCctpNetwork): BridgeToken {
    const chain = `stellar:${network}`;
    const asset = STELLAR_USDC_ASSET[network];
    return {
      // CAIP-19 constrains `asset_namespace` to `[-a-z0-9]{3,8}` and its
      // reference grammar excludes the colon, so `CODE:ISSUER` is encoded
      // `asset:CODE-ISSUER` (Stellar's own canonical display form).
      caip19: buildCaip19(chain, "asset", asset.replace(":", "-")),
      chain,
      address: asset,
      symbol: "USDC",
      name: "USD Coin",
      // SEVEN, not six (§5.4.1, §6).
      decimals: STELLAR_USDC_DECIMALS,
      isNative: false,
      verification: "verified",
    };
  }

  /**
   * Deliberately NO `gasTopUp`. Stellar's destination precondition is a
   * TRUSTLINE plus an XLM base reserve, which the recipient must set up
   * themselves; mobile surfaces it via `checkDestinationReadiness` (§7.5).
   * The claim leg also needs a little XLM for its fee, which the same
   * readiness check (funded account) covers.
   */
}
