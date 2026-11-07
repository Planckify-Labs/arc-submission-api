import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsObject,
  ValidateNested,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
} from "class-validator";
import { Type } from "class-transformer";

interface CustomerInfoObject {
  [key: string]: string | number | boolean | string[];
}

interface CustomerInfoKeyValue {
  key: string;
  value: string;
}

type CustomerInfo = CustomerInfoObject | CustomerInfoKeyValue[];

export class PaymentDetailsDto {
  @ApiProperty({
    description: "Token contract address on the blockchain",
    example: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  })
  @IsString()
  @IsNotEmpty()
  tokenAddress: string;

  @ApiProperty({
    description: "ID of the blockchain from the blockchain table",
    example: "01JX2FJZ7Y37Y9XXDHYP323P0X",
  })
  @IsString()
  @IsNotEmpty()
  blockchainId: string;

  @ApiProperty({
    description:
      "Deprecated, ignored. The server picks the latest active rate for the token and returns its id in payment.exchangeRate.id; pass that id to the contract.",
    example: 1,
    required: false,
    deprecated: true,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  exchangeRateId?: number;
}

export class CreateBookingDto {
  @ApiProperty({
    description: "Wallet address of the user",
    example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  })
  @IsString()
  @IsNotEmpty()
  walletAddress: string;

  @ApiProperty({
    description: "Product variant ID being booked",
    example: "01H1G5V...",
  })
  @IsString()
  @IsNotEmpty()
  productVariantId: string;

  @ApiProperty({
    description: "Product price ID for the booking",
    example: "01H1G5V...",
  })
  @IsString()
  @IsNotEmpty()
  productPriceId: string;

  @ApiProperty({
    description: "Payment details",
    type: PaymentDetailsDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentDetailsDto)
  payment: PaymentDetailsDto;

  @ApiProperty({
    description:
      "Customer information required for the product (varies by product type)",
    examples: {
      objectFormat: {
        value: { phoneNumber: "6281234567890" },
        description: "Object format with direct key-value pairs",
      },
      arrayFormat: {
        value: [{ key: "user_id", value: "085930970697" }],
        description: "Array format with key-value objects (VCGamers format)",
      },
    },
    required: false,
  })
  @IsOptional()
  customerInfo?: CustomerInfo;

  @ApiProperty({
    description:
      "Pay part of the price with points. The server decides how many (see payment.pointsApplied in the response); nothing applicable is a normal token booking.",
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  usePoints?: boolean;
}

export class ExecuteBookingDto {
  @ApiProperty({
    description: "ID of the associated purchase",
    example: "01H1G5V...",
  })
  @IsString()
  @IsNotEmpty()
  purchaseId: string;
}

export class ProductPriceDto {
  @ApiProperty({
    description: "Price amount in the specified currency",
    example: 100000,
  })
  @IsNumber()
  amount: number;

  @ApiProperty({
    description: "Currency code",
    example: "IDR",
  })
  @IsString()
  currency: string;
}

export class ProductVariantDto {
  @ApiProperty({
    description: "Product variant ID",
    example: "01H1G5V...",
  })
  @IsString()
  id: string;

  @ApiProperty({
    description: "Product variant name",
    example: "86 Diamonds",
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: "Product variant code",
    example: "ML-86D",
  })
  @IsString()
  variantCode: string;
}

export class ProductDetailsDto {
  @ApiProperty({
    description: "Product ID",
    example: "01H1G5V...",
  })
  @IsString()
  id: string;

  @ApiProperty({
    description: "Product name",
    example: "Mobile Legends",
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: "Product variant details",
    type: ProductVariantDto,
  })
  @ValidateNested()
  @Type(() => ProductVariantDto)
  variant: ProductVariantDto;

  @ApiProperty({
    description: "Product price details",
    type: ProductPriceDto,
  })
  @ValidateNested()
  @Type(() => ProductPriceDto)
  price: ProductPriceDto;
}

export class TokenDetailsDto {
  @ApiProperty({
    description: "Token symbol",
    example: "USDC",
  })
  @IsString()
  symbol: string;

  @ApiProperty({
    description: "Token contract address on the blockchain",
    example: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  })
  @IsString()
  address: string;

  @ApiProperty({
    description: "Token amount",
    example: "10.5",
  })
  @IsString()
  amount: string;

  @ApiProperty({
    description: "ID of the blockchain from the blockchain table",
    example: "01JX2FJZ7Y37Y9XXDHYP323P0X",
  })
  @IsString()
  blockchainId: string;

  @ApiProperty({
    description: "Name of the blockchain",
    example: "Polygon",
  })
  @IsString()
  blockchainName: string;
}

export class ExchangeRateDetailsDto {
  @ApiProperty({
    description:
      "ID of the locked exchange rate. Pass it to the contract as exchangeRateId; verification compares it on-chain.",
    example: 42,
  })
  @IsNumber()
  id: number;

  @ApiProperty({
    description: "Exchange rate value",
    example: 15700,
  })
  @IsNumber()
  rate: number;

  @ApiProperty({
    description: "Timestamp when the rate was locked",
    example: "2024-03-15T12:00:00Z",
  })
  @IsString()
  lockedAt: string;
}

export class PaymentResponseDto {
  @ApiProperty({
    description: "Points taken from the balance, as a string (\"0\" when none)",
    example: "30000",
  })
  @IsString()
  pointsApplied: string;

  @ApiProperty({
    description: "Token details",
    type: TokenDetailsDto,
  })
  @ValidateNested()
  @Type(() => TokenDetailsDto)
  token: TokenDetailsDto;

  @ApiProperty({
    description: "Exchange rate details",
    type: ExchangeRateDetailsDto,
  })
  @ValidateNested()
  @Type(() => ExchangeRateDetailsDto)
  exchangeRate: ExchangeRateDetailsDto;
}

export class BookingResponseDto {
  @ApiProperty({
    description: "Booking ID",
    example: "01H1G5V...",
  })
  id: string;

  @ApiProperty({
    description: "Wallet address",
    example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  })
  walletAddress: string;

  @ApiProperty({
    description: "Product details",
    type: ProductDetailsDto,
  })
  @ValidateNested()
  @Type(() => ProductDetailsDto)
  product: ProductDetailsDto;

  @ApiProperty({
    description: "Payment details with locked exchange rate",
    type: PaymentResponseDto,
  })
  @ValidateNested()
  @Type(() => PaymentResponseDto)
  payment: PaymentResponseDto;

  @ApiProperty({
    description: "Customer information for the product",
    examples: {
      objectFormat: {
        value: { phoneNumber: "6281234567890" },
        description: "Object format with direct key-value pairs",
      },
      arrayFormat: {
        value: [{ key: "user_id", value: "085930970697" }],
        description: "Array format with key-value objects (VCGamers format)",
      },
    },
    required: false,
  })
  customerInfo?: CustomerInfo;

  @ApiProperty({
    description: "Booking status",
    example: "PENDING",
    enum: ["PENDING", "EXPIRED", "EXECUTED", "CANCELLED"],
  })
  status: string;

  @ApiProperty({
    description: "Expiration timestamp",
    example: "2024-03-15T12:15:00Z",
  })
  expiresAt: string;

  @ApiProperty({
    description: "Creation timestamp",
    example: "2024-03-15T12:00:00Z",
  })
  createdAt: string;
}
