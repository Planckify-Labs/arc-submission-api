import { applyDecorators } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiHeader,
} from "@nestjs/swagger";
import { BookingResponseDto } from "../../booking/dto/booking-response.dto";
import { BookingStatsResponseDto } from "../../booking/dto/booking-query.dto";
import { BookingStatus } from "../../booking/enums/booking-status.enum";

const notFoundResponse = {
  status: 404,
  description: "Booking not found",
};

const invalidInputResponse = {
  status: 400,
  description: "Invalid input data",
};

export function ApiCreateBooking() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Create a new booking",
      description:
        "Creates a new booking with locked exchange rate and 15-minute expiration. Requires payment details including blockchain network and token information.",
    }),
    ApiBody({
      schema: {
        type: "object",
        required: [
          "walletAddress",
          "productVariantId",
          "productPriceId",
          "payment",
        ],
        properties: {
          walletAddress: {
            type: "string",
            description: "Wallet address of the customer",
            example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          },
          productVariantId: {
            type: "string",
            description: "ID of the product variant",
            example: "01H1G5V...",
          },
          productPriceId: {
            type: "string",
            description: "ID of the product price",
            example: "01H1G5V...",
          },
          customerInfo: {
            type: "object",
            description:
              "Customer information required for the product (varies by product type)",
            example: {
              no_hp: "6281234567890",
              email: "user@example.com",
              region: "Asia-Pacific",
            },
            additionalProperties: {
              oneOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                {
                  type: "array",
                  items: { type: "string" },
                },
              ],
            },
          },
          payment: {
            type: "object",
            required: ["tokenAddress", "blockchainId"],
            properties: {
              tokenAddress: {
                type: "string",
                description:
                  "The contract address of the token to be used for payment",
                example: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
              },
              blockchainId: {
                type: "string",
                description:
                  "The ID of the blockchain network where the payment will be processed",
                example: "01JX2FJZ7Y37Y9XXDHYP323P0X",
              },
              exchangeRateId: {
                type: "number",
                deprecated: true,
                description:
                  "Ignored. The server locks the latest active rate and returns its id in payment.exchangeRate.id",
                example: 1,
              },
            },
          },
        },
      },
    }),
    ApiResponse({
      status: 201,
      description: "Booking created successfully",
      type: BookingResponseDto,
    }),
    ApiResponse(invalidInputResponse),
    ApiResponse({
      status: 404,
      description: "Product, price, blockchain network, or token not found",
    }),
  );
}

export function ApiGetWalletBookings() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Get wallet bookings",
      description:
        "Retrieves all bookings for a specific wallet address with optional filters",
    }),
    ApiParam({
      name: "walletAddress",
      description: "Ethereum wallet address",
      example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    }),
    ApiQuery({
      name: "status",
      required: false,
      enum: BookingStatus,
      description: "Filter by booking status",
    }),
    ApiQuery({
      name: "productVariantId",
      required: false,
      type: String,
      description: "Filter by product variant ID",
    }),
    ApiQuery({
      name: "createdFrom",
      required: false,
      type: Date,
      description: "Filter by creation date from (ISO string)",
    }),
    ApiQuery({
      name: "createdTo",
      required: false,
      type: Date,
      description: "Filter by creation date to (ISO string)",
    }),
    ApiResponse({
      status: 200,
      description: "List of bookings",
      type: BookingResponseDto,
      isArray: true,
    }),
  );
}

export function ApiGetLatestBooking() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Get latest active booking",
      description:
        "Retrieves the most recent non-expired pending booking for a wallet",
    }),
    ApiParam({
      name: "walletAddress",
      description: "Ethereum wallet address",
      example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    }),
    ApiResponse({
      status: 200,
      description: "Latest active booking or null if none exists",
      type: BookingResponseDto,
    }),
  );
}

export function ApiGetBookingStats() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Get booking statistics",
      description:
        "Retrieves booking statistics for a wallet including conversion rates and execution times",
    }),
    ApiParam({
      name: "walletAddress",
      description: "Ethereum wallet address",
      example: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    }),
    ApiResponse({
      status: 200,
      description: "Booking statistics",
      type: BookingStatsResponseDto,
    }),
  );
}

export function ApiExecuteBooking() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Execute booking",
      description: "Marks a booking as executed and links it to a purchase",
    }),
    ApiParam({
      name: "id",
      description: "Booking ID",
      example: "01H1G5V...",
    }),
    ApiBody({
      schema: {
        type: "object",
        required: ["purchaseId"],
        properties: {
          purchaseId: {
            type: "string",
            description: "ID of the associated purchase",
            example: "01H1G5V...",
          },
        },
      },
    }),
    ApiResponse({
      status: 200,
      description: "Booking executed successfully",
      type: BookingResponseDto,
    }),
    ApiResponse(invalidInputResponse),
    ApiResponse(notFoundResponse),
  );
}

export function ApiCancelBooking() {
  return applyDecorators(
    ApiBearerAuth(),
    ApiHeader({
      name: "Authorization",
      required: true,
      description: "JWT token",
      example: "Bearer <token>",
    }),
    ApiOperation({
      summary: "Cancel booking",
      description: "Cancels a pending booking",
    }),
    ApiParam({
      name: "id",
      description: "Booking ID",
      example: "01H1G5V...",
    }),
    ApiResponse({
      status: 200,
      description: "Booking cancelled successfully",
      type: BookingResponseDto,
    }),
    ApiResponse(invalidInputResponse),
    ApiResponse(notFoundResponse),
  );
}
