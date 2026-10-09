/**
 * Bridge capability — canonical wire types.
 *
 * Spec: docs/bridge-capability-spec.md (mobile-app repo) §5, §6, §7.
 *
 * These shapes are the contract between the provider registry (§5.2),
 * the `/bridge/*` controller, and the mobile `BridgeQuoteCard` /
 * `BridgeProgressCard`. Two rules make them load-bearing:
 *
 *  1. **Identity is CAIP-2 / CAIP-19, never a provider number.** LI.FI's
 *     private chain numbering (`1151111081099710` for Solana) lives
 *     inside the adapter and must not leak upward (§5.2). That is what
 *     kills the `0x…{40}` regex problem generically instead of adding a
 *     Solana special-case.
 *  2. **Decimals travel with the token, never as a constant.** Stellar
 *     USDC has 7 decimals; USDC everywhere else has 6 (§5.4.1, §6). A
 *     shared `USDC_DECIMALS = 6` would misprice every Stellar amount by
 *     10x, so `BridgeToken.decimals` is required and sourced from the
 *     adapter.
 */

/** CAIP-2 chain id, e.g. `eip155:8453`, `solana:5eykt4Us…`, `stellar:pubnet`. */
export type Caip2 = string;

export type RouteKind = "swap" | "bridge";

export function routeKindOf(fromChain: Caip2, toChain: Caip2): RouteKind {
  return fromChain === toChain ? "swap" : "bridge";
}

export function routeQuoteKindOf(quote: { from: { chain: Caip2 }; to: { chain: Caip2 } }): RouteKind {
  return quote.from.chain === quote.to.chain ? "swap" : "bridge";
}

export interface RouteOption {
  dexId?: string;
  name: string;
  /** Absent when the provider does not quote per venue (Tower, live-verified). */
  outputAmountRaw?: string;
  minOutRaw?: string;
  priceImpact?: number;
}

/**
 * CAIP-19 asset id, e.g.
 *   `eip155:8453/erc20:0x833589f…`
 *   `eip155:1/slip44:60`                       (native)
 *   `solana:5eykt4Us…/token:EPjFWdd5…`
 *   `sui:mainnet/coin:0x2::sui::SUI`
 *   `stellar:pubnet/asset:USDC-GA5Z…`
 */
export type Caip19 = string;

/**
 * A token as the bridge surface sees it. `decimals` is REQUIRED — see the
 * file header. `address` is the provider/chain-native identifier
 * (0x-address, SPL mint, Sui coin type, Stellar `CODE:ISSUER`) and is
 * carried alongside the CAIP-19 id so callers never have to re-parse.
 */
export interface BridgeToken {
  caip19: Caip19;
  chain: Caip2;
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  priceUsd?: string;
  logoUri?: string;
  /**
   * Whether the asset is the chain's native/gas token. Drives the
   * "you receive native USDC" style disclosure (§7.1) together with
   * `BridgeQuote.receivesNativeAsset`.
   */
  isNative: boolean;
  /**
   * Provider-reported token trust signal (§7.3). Curated to a closed set
   * so no raw provider string reaches the UI.
   */
  verification: "verified" | "unverified" | "unknown";
}

/**
 * One itemised fee line (§7.2). `included` is the field the spec calls
 * out as urgent: it says whether the fee is ALREADY deducted from the
 * output or charged on top. Ignoring it means double-counting or
 * under-reporting.
 */
export interface BridgeFee {
  /** Stable machine key so the card can order/label without parsing prose. */
  key:
    | "bridge"
    | "integrator"
    | "gas_source"
    | "gas_destination"
    | "forwarding"
    | "gas_top_up"
    | "other";
  /** Hand-written label. Never a raw provider string. */
  label: string;
  amountRaw: string;
  token: BridgeToken;
  amountUsd?: string;
  /** `true` = already deducted from the output; `false` = charged on top. */
  included: boolean;
}

/**
 * Trust model of the mechanism actually moving the funds (§7.3). Users
 * are entitled to know which one they are in, so this is a closed enum
 * rather than free text.
 */
export type BridgeMechanism =
  | "burn_mint"
  | "liquidity_pool"
  | "intent_filler"
  | "unknown";

export interface BridgeProviderInfo {
  /** Provider tool key, e.g. `mayanFastMCTP`, `across`. */
  key: string;
  /** Display name from the provider, e.g. "Mayan (MCTP)". */
  name: string;
  logoUri?: string;
  mechanism: BridgeMechanism;
}

/**
 * One leg of a multi-step route (§7.3 route breakdown, §7.7 progress).
 *
 * CCTP's lifecycle is four steps (`approve` → `burn` → `fetchAttestation`
 * → `mint`) and non-CCTP LI.FI routes map onto the same shape via
 * `includedSteps`, so the progress card stays provider-agnostic. Step 1
 * is PRESENCE-CHECKED, never assumed — there is no approve analogue on
 * Solana / Sui / Stellar (§7.7, §10.4).
 */
export interface BridgeRouteStep {
  key: string;
  kind: "approve" | "swap" | "burn" | "attestation" | "mint" | "protocol";
  /** Hand-written label. */
  label: string;
  fromChain?: Caip2;
  toChain?: Caip2;
  fromToken?: BridgeToken;
  toToken?: BridgeToken;
  fromAmountRaw?: string;
  toAmountRaw?: string;
  provider?: BridgeProviderInfo;
}

/**
 * A destination precondition that is not satisfied yet (§7.5).
 *
 * The general problem is per-namespace readiness, of which gas is only
 * the EVM case. Each blocker carries its own remedy so the card renders
 * them uniformly and adding a namespace never edits the card.
 */
export interface BridgeBlocker {
  code:
    | "no_destination_gas"
    | "missing_trustline"
    | "account_not_funded"
    | "missing_token_account";
  /** Hand-written explanation. Never raw error text. */
  message: string;
  severity: "warning" | "blocking";
  remedy:
    | { kind: "gas_top_up"; suggestedUsd: number }
    | { kind: "establish_trustline"; asset: Caip19 }
    // `symbol` rather than a full token: the readiness check knows the
    // chain's native asset by name but has no price/logo metadata, and
    // inventing it would be worse than omitting it.
    | { kind: "fund_account"; minimumRaw: string; symbol: string }
    | { kind: "none" };
}

export interface BridgeQuoteRequest {
  fromChain: Caip2;
  toChain: Caip2;
  fromAsset: Caip19;
  toAsset: Caip19;
  /** Smallest-unit decimal string of the SOURCE token. */
  amountRaw: string;
  fromAddress: string;
  /** Destination address. Cross-namespace this is a DIFFERENT address (§7.4). */
  toAddress: string;
  /**
   * Slippage is a fixed server-side default per route class, disclosed but
   * NOT user-adjustable and NOT model-supplied (§8.4). Present here only so
   * internal callers (the gas-top-up composer) can pin it; the public DTO
   * does not expose it.
   */
  slippageBps?: number;
  /**
   * The minimum the user approved (the card's `toAmountMinRaw`), sent by
   * the device's execute-time re-quote. Lets the server keep that floor
   * when the market ticks between quote and signing: it may only TIGHTEN
   * slippage so the fresh route's on-chain minimum still meets it, never
   * loosen it. Not a slippage input, so §8.4 holds.
   */
  minReceiveRaw?: string;
  transferSpeedHint?: "fast" | "standard";
  useForwarder?: boolean;
}

/**
 * The provider-built payload the mobile side signs and submits.
 *
 * Tagged by PAYLOAD SHAPE, not by namespace: mobile dispatches it through
 * the `WalletKitAdapter.submitBridgeExecution` optional capability, so no
 * shared code branches on `namespace === "eip155"` (CLAUDE.md hard rule,
 * enforced by `pnpm check:chains`).
 */
export type BridgeExecutionPayload =
  | {
      kind: "evm_transaction";
      chain: Caip2;
      to: string;
      data: string;
      value: string;
      gasPrice?: string;
      gasLimit?: string;
      /**
       * ERC-20 allowance the EVM kit must ensure before submitting. Absent
       * for native sources and for every non-EVM namespace.
       */
      approval?: {
        token: string;
        spender: string;
        amountRaw: string;
      };
    }
  | {
      /** Provider-serialised transaction (Solana / Sui). The kit deserialises,
       *  signs with the wallet's key, and submits. */
      kind: "serialized_transaction";
      chain: Caip2;
      encoding: "base64" | "hex";
      payload: string;
    }
  | {
      /** Soroban contract invocation (CCTP Stellar leg, phase 4). */
      kind: "soroban_invoke";
      chain: Caip2;
      contractId: string;
      method: string;
      /** Pre-encoded XDR ScVal args, base64 each, in positional order. */
      argsXdrBase64: string[];
      /**
       * SEP-41 allowance the Stellar kit must grant first — the Soroban
       * analogue of the EVM `approval`. Stellar's CCTP
       * `TokenMessengerMinter` pulls the burn with `transfer_from`
       * (confirmed by testnet simulation, 2026-09-26: without it the USDC
       * SAC fails with "not enough allowance to spend"), so a
       * Stellar-source burn needs `approve(from, spender, amount,
       * expiration_ledger)` on the USDC contract. `token` and `spender`
       * are `C…` contract ids; `amountRaw` is in the token's own decimals.
       */
      approval?: {
        token: string;
        spender: string;
        amountRaw: string;
      };
    }
  | {
      /**
       * A Circle bridge that the DEVICE runs through Arc App Kit's own
       * `bridge()`, with the user's signer (§5.4).
       *
       * Deliberately PARAMETERS, never calldata: App Kit builds the
       * approve and burn itself against Circle's pinned contracts, so a
       * compromised backend cannot slip a different target in here. The
       * device still checks every field against the quote the user
       * approved before it signs anything.
       */
      kind: "circle_app_kit_bridge";
      /** Source chain, CAIP-2 (the chain the device signs on). */
      chain: Caip2;
      /** Which Circle product. Selects the device-side hand-off step. */
      protocol: "cctp" | "cctpx";
      /** App Kit chain identifiers, e.g. `"Base"`, `"Arc"`. */
      sourceChain: string;
      destinationChain: string;
      /** App Kit token alias: `"USDC"` or a CCTPx symbol such as `"EURC"`. */
      token: string;
      /** The source token contract the alias must resolve to. */
      tokenAddress: string;
      /** Human decimal string, the only amount format App Kit accepts. */
      amount: string;
      recipientAddress: string;
      transferSpeed: "SLOW";
      /** Always true: the phone hands off once the burn is on-chain. */
      useForwarder: true;
      /** Human decimal cap on the protocol fee (USDC routes). */
      maxFee?: string;
      /** Provider-signed quote, OPAQUE, passed back to `bridge()` as-is. */
      quote?: unknown;
    };

/**
 * Terminal outcome. FOUR values, never a boolean (§7.7.1).
 *
 * LI.FI's `DONE` has three outcomes and two of them are not what the user
 * asked for: `PARTIAL` (full value, DIFFERENT token) and `REFUNDED` (funds
 * back on the SOURCE chain). Treating `DONE` as success renders a
 * "completed" card to a user holding a token they never asked for.
 *
 * `partial` and `refunded` are OUTCOMES, not errors — they must not go
 * through `agentErrorCopy`; they get their own plain explanatory copy
 * naming the token actually received or the chain the refund landed on.
 *
 * CCTP has no equivalent (burn-and-mint is atomic per message) so it only
 * produces `completed` or `failed`; the adapter normalises both providers
 * onto this one enum and the card stays provider-agnostic.
 */
export type BridgeOutcome = "completed" | "partial" | "refunded" | "failed";

export type BridgePhase =
  | "pending_source"
  | "pending_attestation"
  | "pending_destination"
  | "settled";

export interface BridgeStatus {
  /** `null` until the transfer reaches a terminal state. */
  outcome: BridgeOutcome | null;
  phase: BridgePhase;
  /** Key of the `BridgeRouteStep` currently executing, when known. */
  currentStepKey?: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  /** Populated on `partial` — the token the user ACTUALLY received. */
  receivedToken?: BridgeToken;
  receivedAmountRaw?: string;
  /** Populated on `refunded` — where the money went back to. */
  refundChain?: Caip2;
  /** Explorer deep link, when the provider gives one. */
  explorerUrl?: string;
  /**
   * A destination-side invocation the RECIPIENT's own wallet must sign
   * before the transfer can complete. Present only on routes with no
   * Forwarding Service: today, CCTP into Stellar, where someone has to
   * call `CctpForwarder.mint_and_forward(message, attestation)` (§5.4.1).
   * Anyone may call it and the payout target is fixed by the burn, so the
   * user claiming their own funds is safe and needs no third party.
   */
  destinationAction?: BridgeExecutionPayload;
}

export interface BridgeRef {
  provider: string;
  fromChain: Caip2;
  toChain: Caip2;
  sourceTxHash: string;
}

export interface BridgeQuote {
  quoteId: string;
  /** Registry key of the adapter that produced this quote. */
  provider: string;
  from: {
    chain: Caip2;
    /** Resolved display name, so the card never derives one. */
    chainName?: string;
    token: BridgeToken;
    address: string;
    amountRaw: string;
    amountUsd?: string;
  };
  to: {
    chain: Caip2;
    /** Resolved display name, so the card never derives one. */
    chainName?: string;
    token: BridgeToken;
    /** The DESTINATION address, shown explicitly on the card (§7.4). */
    address: string;
    amountRaw: string;
    amountUsd?: string;
  };
  /** Worst-case guarantee. Without it there is no protection number on screen. */
  toAmountMinRaw: string;
  /** Derived from topology ("swap" | "bridge"). */
  kind: RouteKind;
  /** Price impact in PERCENT (1.5 = 1.5%), as Tower documents it. Absent = unknown, never 0. */
  priceImpact?: number;
  /** Winning venue details: whose pool the trade actually hits. */
  venue?: { key: string; name: string; logoUri?: string };

  /** Alternative route options. */
  routeOptions?: RouteOption[];
  /** Disclosed, fixed per route class, not user-adjustable (§8.4). */
  slippageBps: number;
  fees: BridgeFee[];
  /** Whether the destination asset is the canonical/native issuance
   *  (the entire user-visible point of CCTP, §7.1). */
  receivesNativeAsset: boolean;
  durationSeconds: number;
  /** `[min, max]` when the provider gives a range (§7.3). */
  durationRangeSeconds?: [number, number];
  bridge: BridgeProviderInfo;
  steps: BridgeRouteStep[];
  execution: BridgeExecutionPayload;
  /** ISO-8601. Drives the freshness indicator + re-quote (§8.2). */
  issuedAt: string;
  /** ISO-8601. A quote past this is `stale_precondition`, never submitted. */
  expiresAt: string;
}

/** One reachable chain in the queried support matrix (§5.3). */
export interface BridgeSupportedChain {
  chain: Caip2;
  name: string;
  /** Provider keys that can serve this chain. */
  providers: string[];
  logoUri?: string;
  nativeSymbol?: string;
}

/** One validated bridge pair: the same asset on both sides. */
export interface BridgeRoutePair {
  from: BridgeToken;
  to: BridgeToken;
  /** Adapters that route it, in preference order. */
  providers: string[];
}

/** `GET /bridge/route-tokens`: what a picker may offer for one route. */
export interface BridgeRouteTokens {
  from: Caip2;
  to: Caip2;
  /** Bridge (`from` ≠ `to`): exact pairs. Empty for a swap. */
  pairs: BridgeRoutePair[];
  /** Swap (`from` = `to`): tradable tokens. Empty for a bridge. */
  tokens: BridgeToken[];
  /** A provider could not be checked; its tokens are left out. */
  degraded: boolean;
}

/** What a wallet on one chain can reach (`GET /bridge/reach`). */
export interface BridgeReach {
  chain: Caip2;
  /** A provider swaps on this chain. */
  swap: boolean;
  /** Enabled chains a provider bridges to from this one. */
  destinations: BridgeSupportedChain[];
  degraded: boolean;
}

export interface BridgeSupport {
  chains: BridgeSupportedChain[];
  providers: Array<{
    key: string;
    /** Bridge tool keys the provider aggregates, when it aggregates any. */
    tools: string[];
  }>;
  /** ISO-8601 of the underlying fetch, so callers can see staleness. */
  refreshedAt: string;
  /**
   * `true` when the matrix came from a stale cache because the live fetch
   * failed. Callers degrade to "we could not check routes right now" —
   * NEVER to a wrong "unsupported" (§5.3).
   */
  degraded: boolean;
}

export interface GasTopUpRequest {
  chain: Caip2;
  toAddress: string;
  /** Source chain + asset the slice is taken from. */
  fromChain: Caip2;
  fromAsset: Caip19;
  fromAddress: string;
  amountUsd: number;
}

export type RouteQuote = BridgeQuote;
export type RouteQuoteRequest = BridgeQuoteRequest;
export type RouteToken = BridgeToken;
export type RouteSupportedChain = BridgeSupportedChain;
export type RouteRef = BridgeRef;
export type RouteStatus = BridgeStatus;
