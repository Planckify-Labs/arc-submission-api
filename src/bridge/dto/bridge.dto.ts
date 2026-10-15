/**
 * Bridge DTOs — CAIP-2 / CAIP-19 shaped.
 *
 * Spec: docs/bridge-capability-spec.md §4.1, §5.1.
 *
 * This is the direct replacement for the blocker in
 * `strategies/dto/cross-chain-quote.dto.ts`, where every address field was
 * `@Matches(/^0x[a-fA-F0-9]{40}$/)` and every chain field `@IsInt()` — so a
 * Solana mint or a Sui coin type was literally INEXPRESSIBLE.
 *
 * Validating the CAIP grammar instead of an EVM address shape fixes that
 * generically. Adding a namespace needs no DTO change at all.
 */

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

/**
 * CAIP-2. Deliberately NOT `\d+` — `sui:mainnet` and `stellar:pubnet` have
 * non-numeric references, which is exactly what the old `@IsInt()` chain
 * fields could not express.
 */
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/**
 * CAIP-19. The asset reference is permissive on purpose: it must hold a Sui
 * coin type (`0x2::sui::SUI`) and a Stellar `CODE:ISSUER` pair alongside an
 * EVM address and a base58 Solana mint.
 */
const CAIP19 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,32}(?::.{1,128})?$/;

/**
 * Chain-native address. One bounded, namespace-agnostic rule rather than an
 * EVM regex: EVM hex, Solana base58, Sui hex, and Stellar strkey all pass,
 * and the adapter does the real validation because only it knows the
 * encoding. Case is NEVER folded here — Solana base58 and Stellar strkeys
 * are case-sensitive (`feedback_address_case_per_encoding`).
 */
const CHAIN_ADDRESS = /^[a-zA-Z0-9:_.-]{16,128}$/;

const AMOUNT_RAW = /^[0-9]{1,78}$/;

export class BridgeQuoteDto {
  @ApiProperty({ description: "Source chain, CAIP-2.", example: "eip155:8453" })
  @IsString()
  @Matches(CAIP2, { message: "fromChain must be a CAIP-2 chain id" })
  fromChain: string;

  @ApiProperty({
    description: "Destination chain, CAIP-2.",
    example: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  })
  @IsString()
  @Matches(CAIP2, { message: "toChain must be a CAIP-2 chain id" })
  toChain: string;

  @ApiProperty({
    description: "Source asset, CAIP-19.",
    example: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  })
  @IsString()
  @Matches(CAIP19, { message: "fromAsset must be a CAIP-19 asset id" })
  fromAsset: string;

  @ApiProperty({ description: "Destination asset, CAIP-19." })
  @IsString()
  @Matches(CAIP19, { message: "toAsset must be a CAIP-19 asset id" })
  toAsset: string;

  @ApiProperty({
    description: "Amount in the SOURCE token's smallest unit (decimal string).",
  })
  @IsString()
  @Matches(AMOUNT_RAW)
  amountRaw: string;

  @ApiProperty({
    description:
      "Source wallet address, in the source chain's own encoding. Case preserved.",
  })
  @IsString()
  @Matches(CHAIN_ADDRESS)
  @MaxLength(128)
  fromAddress: string;

  @ApiProperty({
    description:
      "Destination wallet address, in the DESTINATION chain's encoding. " +
      "Cross-namespace this is a different address than fromAddress.",
  })
  @IsString()
  @Matches(CHAIN_ADDRESS)
  @MaxLength(128)
  toAddress: string;

  @ApiPropertyOptional({
    description:
      "The minimum the user approved, in the destination token's smallest unit. Execute-time re-quotes send it so the route can be held to it; slippage is only ever tightened, never loosened.",
  })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_RAW)
  minReceiveRaw?: string;
}

export class BridgeTokenSearchQueryDto {
  @ApiProperty({ description: "Chain to search, CAIP-2.", example: "eip155:5042" })
  @IsString()
  @Matches(CAIP2)
  chain: string;

  @ApiProperty({
    description:
      "Symbol, name or contract address as the user said it, or an exact CAIP-19 to check.",
    example: "cirBTC",
  })
  @IsString()
  @Matches(/^[\p{L}\p{N} ._₮:\/-]{1,160}$/u)
  query: string;
}

export class BridgeStatusQueryDto {
  @ApiProperty({ description: "Source chain, CAIP-2." })
  @IsString()
  @Matches(CAIP2)
  fromChain: string;

  @ApiProperty({ description: "Destination chain, CAIP-2." })
  @IsString()
  @Matches(CAIP2)
  toChain: string;

  @ApiProperty({
    description:
      "Source-chain transaction hash / signature / digest, in that chain's encoding.",
  })
  @IsString()
  @Matches(/^[a-zA-Z0-9]{16,128}$/)
  txHash: string;

  @ApiPropertyOptional({
    description: "Adapter key that produced the quote. Defaults to auto-resolve.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  provider?: string;
}

export class BridgeGasTopUpDto {
  @ApiProperty({ description: "Chain that needs gas, CAIP-2." })
  @IsString()
  @Matches(CAIP2)
  chain: string;

  @ApiProperty({ description: "Address that needs gas, on `chain`." })
  @IsString()
  @Matches(CHAIN_ADDRESS)
  @MaxLength(128)
  toAddress: string;

  @ApiProperty({ description: "Chain the slice is taken from, CAIP-2." })
  @IsString()
  @Matches(CAIP2)
  fromChain: string;

  @ApiProperty({ description: "Asset the slice is taken from, CAIP-19." })
  @IsString()
  @Matches(CAIP19)
  fromAsset: string;

  @ApiProperty({ description: "Source address on `fromChain`." })
  @IsString()
  @Matches(CHAIN_ADDRESS)
  @MaxLength(128)
  fromAddress: string;

  @ApiProperty({
    description: "USD value of gas to buy. Small by design.",
    minimum: 1,
    maximum: 25,
  })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  amountUsd: number;
}

export class BridgeReachQueryDto {
  @ApiProperty({ description: "Source chain, CAIP-2.", example: "eip155:8453" })
  @IsString()
  @Matches(CAIP2)
  from: string;
}

export class BridgeTokenListQueryDto {
  @ApiProperty({ description: "Chain to list, CAIP-2.", example: "eip155:8453" })
  @IsString()
  @Matches(CAIP2)
  chain: string;
}

export class BridgeRouteTokensQueryDto {
  @ApiProperty({ description: "Source chain, CAIP-2.", example: "eip155:84532" })
  @IsString()
  @Matches(CAIP2)
  from: string;

  @ApiProperty({
    description: "Destination chain, CAIP-2. Same as `from` for a swap.",
    example: "eip155:5042002",
  })
  @IsString()
  @Matches(CAIP2)
  to: string;
}
