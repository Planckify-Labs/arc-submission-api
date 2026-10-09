/**
 * `/bridge/*` — the general-purpose bridge surface.
 *
 * Spec: docs/bridge-capability-spec.md §5.3, §7.6, §8.3.
 *
 * Replaces the EVM-only `/strategies/cross-chain/*` pair as the primary
 * route. Those endpoints stay for back-compat; this one speaks CAIP-2 /
 * CAIP-19 and therefore expresses Solana mints, Sui coin types, and
 * Stellar assets that the old DTO could not (§4.1).
 */

import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { DefiErrorFilter } from "../strategies/errors/defi-error";
import { BridgeService, type BridgeQuoteResult } from "./bridge.service";
import {
  BridgeGasTopUpDto,
  BridgeQuoteDto,
  BridgeReachQueryDto,
  BridgeRouteTokensQueryDto,
  BridgeStatusQueryDto,
  BridgeTokenListQueryDto,
  BridgeTokenSearchQueryDto,
} from "./dto/bridge.dto";
import type {
  BridgeQuote,
  BridgeReach,
  BridgeRouteTokens,
  BridgeStatus,
  BridgeSupport,
  BridgeToken,
} from "./types";

@ApiTags("bridge")
@Controller("bridge")
@UseGuards(JwtAuthGuard)
@UseFilters(DefiErrorFilter)
export class BridgeController {
  constructor(private readonly bridgeService: BridgeService) {}

  @Get("support")
  @ApiOperation({
    summary:
      "Queryable route-support matrix. A provider adding a chain lights up here with no deploy.",
  })
  @ApiResponse({ status: 200, description: "Support matrix returned" })
  getSupport(): Promise<BridgeSupport> {
    return this.bridgeService.getSupport();
  }

  @Post("quote")
  @ApiOperation({
    summary:
      "Quote a cross-chain transfer. Returns routable:false for capability boundaries, not an error.",
  })
  @ApiResponse({ status: 200, description: "Quote or a no-route explanation" })
  quote(@Body() dto: BridgeQuoteDto): Promise<BridgeQuoteResult> {
    // "No route" is a first-class STATE, not a failure (§7.6) — so an
    // unroutable pair returns 200 with `routable: false` and the mobile
    // card renders a plain explanatory surface instead of an error card.
    return this.bridgeService.quote({
      fromChain: dto.fromChain,
      toChain: dto.toChain,
      fromAsset: dto.fromAsset,
      toAsset: dto.toAsset,
      amountRaw: dto.amountRaw,
      fromAddress: dto.fromAddress,
      toAddress: dto.toAddress,
      // A floor, not a slippage: it can only make the route stricter.
      minReceiveRaw: dto.minReceiveRaw,
      // Slippage is deliberately absent from the DTO: it is a fixed
      // server-side default per route class, disclosed on the card but
      // NOT user-adjustable and NOT model-supplied (§8.4). A
      // safety-critical number must not be under LLM control.
    });
  }

  @Get("reach")
  @ApiOperation({
    summary:
      "From one chain: can a provider swap there, and which enabled chains can it bridge to. Drives the bridge destination picker.",
  })
  getReach(@Query() query: BridgeReachQueryDto): Promise<BridgeReach> {
    return this.bridgeService.reach(query.from);
  }

  @Get("route-tokens")
  @ApiOperation({
    summary:
      "Validated tokens for one route: same-asset pairs for a bridge, tradable tokens for a swap. Only what a provider actually routes.",
  })
  getRouteTokens(
    @Query() query: BridgeRouteTokensQueryDto,
  ): Promise<BridgeRouteTokens> {
    return this.bridgeService.routeTokens(query.from, query.to);
  }

  @Get("tokens")
  @ApiOperation({
    summary:
      "The route providers' token list for a chain, vouched tokens first. The device merges its own catalogue rows.",
  })
  listTokens(@Query() query: BridgeTokenListQueryDto): Promise<BridgeToken[]> {
    return this.bridgeService.listTokens(query.chain);
  }

  @Get("tokens/search")
  @ApiOperation({
    summary:
      "Find a token on a chain by symbol, name or address, from the route providers' token lists.",
  })
  searchTokens(@Query() query: BridgeTokenSearchQueryDto) {
    return this.bridgeService.searchTokens(query.chain, query.query);
  }

  @Get("status")
  @ApiOperation({
    summary:
      "Poll a submitted bridge. Terminal state is a four-value outcome, never a boolean.",
  })
  getStatus(@Query() query: BridgeStatusQueryDto): Promise<BridgeStatus> {
    return this.bridgeService.status({
      provider: query.provider ?? "",
      fromChain: query.fromChain,
      toChain: query.toChain,
      sourceTxHash: query.txHash,
    });
  }

  @Post("gas-top-up")
  @ApiOperation({
    summary:
      "Quote a small slice of the source asset into the destination's gas token.",
  })
  gasTopUp(@Body() dto: BridgeGasTopUpDto): Promise<BridgeQuote> {
    return this.bridgeService.gasTopUp({
      chain: dto.chain,
      toAddress: dto.toAddress,
      fromChain: dto.fromChain,
      fromAsset: dto.fromAsset,
      fromAddress: dto.fromAddress,
      amountUsd: dto.amountUsd,
    });
  }
}
