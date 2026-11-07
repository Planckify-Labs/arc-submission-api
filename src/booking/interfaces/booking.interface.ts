import { BookingStatus } from "../enums/booking-status.enum";
import { ProductVariant, ProductPrice, Product } from "@generated/prisma";
import { Prisma } from "@generated/prisma";
type JsonValue = Prisma.JsonValue;

export interface BookingPayment {
  tokenAddress: string;
  blockchainNetworkId: string;
  amount: string;
}

export interface TokenDetails {
  symbol: string;
  address: string;
  amount: string;
  blockchainId: string;
  blockchainName: string;
  chainId: number;
  blockExplorer: string;
}

export interface BookingExchangeRate {
  id: number;
  rate: number;
  fromCurrency: string;
  toCurrency: string;
  lockedAt: string;
}

export interface PaymentResponse {
  token: TokenDetails;
  exchangeRate: BookingExchangeRate;
}

export interface DbBooking {
  id: string;
  walletAddress: string;
  productVariantId: string;
  productPriceId: string;
  payment: JsonValue;
  exchangeRate: JsonValue;
  status: BookingStatus;
  expiresAt: Date;
  pointsApplied?: bigint;
  createdAt: Date;
  updatedAt: Date;
  productVariant: ProductVariant & { product: Product };
  productPrice: ProductPrice;
}

export interface BookingWithRelations
  extends Omit<DbBooking, "payment" | "exchangeRate"> {
  payment: BookingPayment;
  exchangeRate: BookingExchangeRate;
}

export interface WhereClause {
  walletAddress?: string;
  status?: BookingStatus;
  productVariantId?: string;
  createdAt?: {
    gte?: Date;
    lte?: Date;
  };
}
