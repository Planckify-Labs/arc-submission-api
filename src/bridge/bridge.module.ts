/**
 * Bridge module.
 *
 * Spec: docs/bridge-capability-spec.md §5.2, §5.4.
 *
 * Registration is the ONLY place that knows the adapter set. Adding a
 * provider (Bitcoin, a future Stellar-native bridge) is one `register`
 * call here plus the adapter file — no enum edit, no branch in shared
 * code, and nothing downstream learns a namespace string.
 */

import { Module, type OnModuleInit } from "@nestjs/common";
import { AlchemyPricesClient } from "../strategies/external/alchemy-prices.client";
import { TokensModule } from "../tokens/tokens.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { BridgeController } from "./bridge.controller";
import { BridgeService } from "./bridge.service";
import { CctpStellarAdapter } from "./providers/cctp-stellar.adapter";
import { CircleAppKitClient } from "./providers/circle/app-kit.client";
import { CircleCctpAdapter } from "./providers/circle/circle-cctp.adapter";
import { CircleCctpxAdapter } from "./providers/circle/circle-cctpx.adapter";
import { LifiBridgeAdapter } from "./providers/lifi.adapter";
import { TowerSwapAdapter } from "./providers/tower.adapter";
import { registerBridgeAdapter } from "./registry";

@Module({
  // Valkey backs the shared Alchemy price cache and daily budget.
  // Tokens provides the Alchemy token-metadata client for picker icons.
  imports: [ValkeyModule, TokensModule],
  controllers: [BridgeController],
  providers: [
    BridgeService,
    AlchemyPricesClient,
    CircleAppKitClient,
    LifiBridgeAdapter,
    CircleCctpAdapter,
    CircleCctpxAdapter,
    CctpStellarAdapter,
    TowerSwapAdapter,
  ],
  exports: [BridgeService],
})
export class BridgeModule implements OnModuleInit {
  constructor(
    private readonly lifi: LifiBridgeAdapter,
    private readonly circleCctp: CircleCctpAdapter,
    private readonly circleCctpx: CircleCctpxAdapter,
    private readonly cctpStellar: CctpStellarAdapter,
    private readonly tower: TowerSwapAdapter,
  ) {}

  onModuleInit(): void {
    // Registration order is the tie-break among adapters that answer the
    // same route (swap spec §4.3): specialists first, the generalist last.
    // That, not a chain list in any adapter, is what puts Tower ahead of
    // LI.FI for a same-chain swap on a chain Tower serves; LI.FI stays the
    // fallback whenever Tower declines.

    // `tower` — SAME-CHAIN swaps on the chains Tower serves. Refuses
    // cross-chain routes, so it never competes with the Circle adapters.
    registerBridgeAdapter(this.tower);

    // `circle-cctp` — USDC over CCTP V2, built on Arc App Kit (§5.4).
    // Declares `supportsAsset`, so the registry sorts it AHEAD of LI.FI
    // for USDC: Standard CCTP is free, LI.FI charges 25 bps on top, and
    // LI.FI serves no route on Arc mainnet at all. LI.FI remains the
    // fallback whenever this adapter declines a quote.
    registerBridgeAdapter(this.circleCctp);

    // `circle-cctpx` — EURC over Circle's CCTP for non-USDC assets, also
    // on App Kit. A different Circle product from USDC, so a different
    // adapter, never a branch (§2).
    registerBridgeAdapter(this.circleCctpx);

    // `cctp` — USDC between EVM and STELLAR, both directions, as raw
    // CCTP calls: App Kit does not reach Stellar. No overlap with
    // `circle-cctp`, which never touches a Stellar chain.
    registerBridgeAdapter(this.cctpStellar);

    // `lifi` — any asset, 72 chains, EVM + Solana + Sui. Misses Stellar.
    // Last: the generalist answers whatever the specialists above decline.
    registerBridgeAdapter(this.lifi);
  }
}
