import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { CreateBookingDto } from "./dto/booking.dto";
import { ConfigService } from "@nestjs/config";
import {
  BookingPayment,
  BookingExchangeRate,
  WhereClause,
  DbBooking,
} from "./interfaces/booking.interface";
import { PrismaService } from "../prisma/prisma.service";
import { BookingQueryDto } from "./dto/booking-query.dto";
import { Prisma, PointsHoldStatus } from "@generated/prisma";
const Decimal = Prisma.Decimal;
import { BookingStatus } from "./enums/booking-status.enum";
import { BlockchainsService } from "../blockchains/blockchains.service";
import {
  ProductInputValidatorService,
} from "../products/services/product-input-validator.service";
import { BookingCacheService } from "../valkey/services/booking-cache.service";
import { addressesEqual } from "../auth/address-compare";
import { ExchangeRateService } from "../exchange-rate/exchange-rate.service";
import { PointsHoldService } from "../points-hold/points-hold.service";
import { computePointsApplied } from "../points-hold/points-allocation";

// Enough digits that dividing an 18-decimal-scaled fiat price by a rate never
// rounds before we round up. Prisma's default (20 significant digits) can drop
// the last wei of a large amount, and the rounding mode is ROUND_UP so a
// shortfall can only ever land on the buyer's side of the ledger.
const TokenAmountDecimal = Decimal.clone({
  precision: 60,
  rounding: Decimal.ROUND_UP,
});

@Injectable()
export class BookingService {
  private readonly BOOKING_EXPIRY_MINUTES: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly blockchainsService: BlockchainsService,
    private readonly productInputValidator: ProductInputValidatorService,
    private readonly bookingCache: BookingCacheService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly holds: PointsHoldService,
  ) {
    this.BOOKING_EXPIRY_MINUTES = this.configService.get(
      "BOOKING_EXPIRY_MINUTES",
      15,
    );
  }

  async createBooking(createBookingDto: CreateBookingDto, userId?: string) {
    const {
      walletAddress,
      productVariantId,
      productPriceId,
      payment,
      customerInfo,
      usePoints,
    } = createBookingDto;

    const booking = await this.prisma.$transaction(async (tx) => {
      const blockchain = await this.blockchainsService.findOne(
        payment.blockchainId,
      );
      if (!blockchain) {
        throw new NotFoundException(
          `Blockchain network with ID ${payment.blockchainId} not found`,
        );
      }
      if (!blockchain.isActive) {
        throw new BadRequestException(
          `Blockchain network ${blockchain.name} is not active`,
        );
      }

      const token = await tx.token.findUnique({
        where: {
          blockchainId_contractAddress: {
            blockchainId: payment.blockchainId,
            contractAddress: payment.tokenAddress,
          },
        },
      });

      if (!token) {
        throw new BadRequestException(
          `Token with address ${payment.tokenAddress} not found on blockchain ${blockchain.name}`,
        );
      }

      if (!token.isActive) {
        throw new BadRequestException(
          `Token ${token.symbol} (${payment.tokenAddress}) is not active on blockchain ${blockchain.name}`,
        );
      }

      const productVariant = await tx.productVariant.findUnique({
        where: { id: productVariantId },
        include: {
          product: true,
          ProductPrice: {
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      if (!productVariant) {
        throw new NotFoundException(
          `Product variant with ID ${productVariantId} not found`,
        );
      }

      if (!productVariant.ProductPrice.length) {
        throw new BadRequestException(
          `No active price found for product variant ${productVariantId}`,
        );
      }

      const validatedCustomerInfo =
        await this.productInputValidator.validateCustomerInfo(
          productVariant.product.id,
          customerInfo,
        );

      const productPrice = productVariant.ProductPrice[0];

      // The token amount below is derived from the ACTIVE price, and
      // `purchases.service` later derives `amountInFiat` (and so any refund)
      // from the price row stored on the booking. A client-supplied id that
      // names some other (pricier) row must therefore never be stored.
      if (productPriceId !== productPrice.id) {
        throw new BadRequestException(
          `Product price ${productPriceId} is not the active price for variant ${productVariantId}`,
        );
      }

      // The server picks the rate, never the client: the latest rate for
      // (token -> price currency) from the same lookup the points deposit
      // uses, so both payment modes price identically. `payment.exchangeRateId`
      // is still accepted for older clients but is not read.
      const exchangeRate = await this.exchangeRateService.findLatest({
        fromCurrency: token.symbol,
        toCurrency: productPrice.currency,
      });

      if (!exchangeRate || !exchangeRate.isActive || !(exchangeRate.rate > 0)) {
        throw new BadRequestException(
          `No active exchange rate for ${token.symbol} -> ${productPrice.currency}`,
        );
      }

      // Points first: the server decides how many (the client sends no
      // number). Nothing applicable is a normal booking, not an error.
      const pointsApplied =
        usePoints && userId
          ? computePointsApplied({
              sellPrice: productPrice.sellPrice.toString(),
              rate: exchangeRate.rate,
              balance: await this.holds.balanceOf(tx, userId),
            })
          : 0n;

      // ceil((sellPrice - pointsApplied) x 10^decimals / rate) in the token's
      // smallest unit. The product margin is already in sellPrice;
      // `ExchangeRate.markup` (QRIS merchant payments) is deliberately NOT
      // applied here, or the buyer would pay the margin twice. Rounded UP so
      // the buyer is never undercharged by a fraction of a wei.
      const tokenAmount = new TokenAmountDecimal(productPrice.sellPrice.toString())
        .sub(pointsApplied.toString())
        .mul(new TokenAmountDecimal(10).pow(token.decimals))
        .div(new TokenAmountDecimal(exchangeRate.rate.toString()))
        .toDecimalPlaces(0, Decimal.ROUND_UP)
        .toFixed(0);

      const booking = await tx.bookingOrder.create({
        data: {
          walletAddress,
          productVariantId,
          productPriceId,
          payment: {
            tokenAddress: payment.tokenAddress,
            blockchainNetworkId: blockchain.id,
            amount: tokenAmount,
          },
          exchangeRate: {
            id: exchangeRate.id,
            rate: Number(exchangeRate.rate),
            fromCurrency: token.symbol,
            toCurrency: exchangeRate.toCurrency,
            lockedAt: new Date().toISOString(),
          },
          pointsApplied,
          pointsHoldStatus:
            pointsApplied > 0n ? PointsHoldStatus.HELD : PointsHoldStatus.NONE,
          customerInfo:
            validatedCustomerInfo as unknown as Prisma.InputJsonValue,
          status: "PENDING" as BookingStatus,
          expiresAt: new Date(
            Date.now() + this.BOOKING_EXPIRY_MINUTES * 60 * 1000,
          ),
        },
        include: {
          productVariant: {
            include: {
              product: true,
            },
          },
          productPrice: true,
        },
      });

      // Same transaction as the booking: either both exist or neither does.
      if (pointsApplied > 0n && userId) {
        await this.holds.holdInTx(tx, {
          userId,
          bookingId: booking.id,
          points: pointsApplied,
        });
      }

      return this.formatBookingResponse(booking as unknown as DbBooking);
    });

    // Invalidate user's booking cache after creating new booking
    await this.bookingCache.invalidateUserBookings(walletAddress);
    if (usePoints && userId) await this.holds.invalidate(userId);

    return booking;
  }

  async findAllAdmin(query: BookingQueryDto) {
    const { status, cursor, take = 10, skip } = query;
    const useSkip = typeof skip === "number" && skip > 0;
    const where = status ? { status } : undefined;

    const findArgs = {
      skip: useSkip ? skip : cursor ? 1 : 0,
      cursor: useSkip ? undefined : cursor ? { id: cursor } : undefined,
    };

    const [items, total] = await Promise.all([
      this.prisma.bookingOrder.findMany({
        where,
        take,
        ...findArgs,
        orderBy: { createdAt: 'desc' },
        include: {
          purchase: true,
        },
      }),
      this.prisma.bookingOrder.count({ where }),
    ]);

    return { items, total };
  }

  getLatestBooking(walletAddress: string) {
    return this.bookingCache.getLatestBooking(walletAddress, async () => {
      const booking = await this.prisma.bookingOrder.findFirst({
        where: {
          walletAddress,
          status: BookingStatus.PENDING as BookingStatus,
          expiresAt: {
            gt: new Date(),
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          productVariant: {
            include: {
              product: true,
            },
          },
          productPrice: true,
        },
      });

      if (!booking) {
        return null;
      }

      return this.formatBookingResponse(booking as unknown as DbBooking);
    });
  }

  async expireBookings() {
    const result = await this.prisma.bookingOrder.updateMany({
      where: {
        status: BookingStatus.PENDING as BookingStatus,
        expiresAt: {
          lt: new Date(),
        },
        // A purchase row means the buyer has already paid and handed us the
        // tx; it may be waiting on confirmations for far longer than the
        // booking lock lasts. Expiry only ever applies to abandoned bookings.
        purchase: null,
      },
      data: {
        status: BookingStatus.EXPIRED as BookingStatus,
      },
    });

    // Invalidate all booking caches after expiry job
    if (result.count > 0) {
      await this.bookingCache.invalidateBooking();
    }
  }

  async markBookingExecuted(
    bookingId: string,
    user: { id: string; walletAddress?: string; role: string },
  ) {
    const booking = await this.prisma.bookingOrder.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    if (
      user.walletAddress &&
      !addressesEqual(booking.walletAddress, user.walletAddress)
    ) {
      if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
        throw new ForbiddenException("You can only execute your own bookings");
      }
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(
        `Booking is ${booking.status.toLowerCase()}`,
      );
    }

    if (booking.expiresAt < new Date()) {
      throw new BadRequestException("Booking has expired");
    }

    const result = await this.prisma.bookingOrder.update({
      where: { id: bookingId },
      data: {
        status: "EXECUTED" as BookingStatus,
      },
    });

    // Invalidate cache after status change
    await this.bookingCache.invalidateBooking(bookingId, booking.walletAddress);

    return result;
  }

  async cancelBooking(
    bookingId: string,
    user: { id: string; walletAddress?: string; role: string },
  ) {
    const booking = await this.prisma.bookingOrder.findUnique({
      where: { id: bookingId },
      include: { purchase: { select: { id: true } } },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    if (
      user.walletAddress &&
      !addressesEqual(booking.walletAddress, user.walletAddress)
    ) {
      if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
        throw new ForbiddenException("You can only cancel your own bookings");
      }
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(
        `Booking is already ${booking.status.toLowerCase()}`,
      );
    }

    // A purchase means the buyer has paid and handed us the transaction.
    // Cancelling then would race the worker with money on the chain.
    const cancelled = await this.prisma.bookingOrder.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.PENDING as BookingStatus,
        purchase: null,
      },
      data: { status: BookingStatus.CANCELLED as BookingStatus },
    });
    if (cancelled.count !== 1) {
      throw new BadRequestException(
        booking.purchase
          ? "This booking has a payment in progress and can no longer be cancelled"
          : "Booking can no longer be cancelled",
      );
    }

    // Points held for it go back (no-op when none were held).
    await this.holds.release(bookingId, "booking cancelled");

    // Invalidate cache after status change
    await this.bookingCache.invalidateBooking(bookingId, booking.walletAddress);

    return { ...booking, status: BookingStatus.CANCELLED };
  }

  async getBookings(walletAddress: string, query: BookingQueryDto) {
    const where: WhereClause = { walletAddress };

    if (query.status) {
      where.status = query.status as BookingStatus;
    }

    if (query.productId) {
      where.productVariantId = query.productId;
    }

    if (query.createdFrom || query.createdTo) {
      where.createdAt = {};
      if (query.createdFrom) {
        where.createdAt.gte = query.createdFrom;
      }
      if (query.createdTo) {
        where.createdAt.lte = query.createdTo;
      }
    }

    // Booking list queries are not cached due to filter variability
    const bookings = await this.prisma.bookingOrder.findMany({
      where,
      include: {
        productVariant: {
          include: {
            product: true,
          },
        },
        productPrice: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return bookings.map((booking) =>
      this.formatBookingResponse(booking as unknown as DbBooking),
    );
  }

  async getBookingStats(walletAddress: string) {
    const [total, pending, executed, expired, cancelled, executionTimes] =
      await Promise.all([
        this.prisma.bookingOrder.count({
          where: { walletAddress },
        }),
        this.prisma.bookingOrder.count({
          where: {
            walletAddress,
            status: BookingStatus.PENDING as BookingStatus,
          },
        }),
        this.prisma.bookingOrder.count({
          where: {
            walletAddress,
            status: BookingStatus.EXECUTED as BookingStatus,
          },
        }),
        this.prisma.bookingOrder.count({
          where: {
            walletAddress,
            status: BookingStatus.EXPIRED as BookingStatus,
          },
        }),
        this.prisma.bookingOrder.count({
          where: {
            walletAddress,
            status: BookingStatus.CANCELLED as BookingStatus,
          },
        }),
        this.prisma.bookingOrder.findMany({
          where: {
            walletAddress,
            status: BookingStatus.EXECUTED as BookingStatus,
          },
          select: {
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

    const avgTimeToExecution =
      executionTimes.length > 0
        ? executionTimes.reduce((acc, booking) => {
            const executionTime =
              booking.updatedAt.getTime() - booking.createdAt.getTime();
            return acc + executionTime / (1000 * 60);
          }, 0) / executionTimes.length
        : undefined;

    return {
      total,
      pending,
      executed,
      expired,
      cancelled,
      conversionRate: total > 0 ? executed / total : 0,
      expirationRate: total > 0 ? expired / total : 0,
      avgTimeToExecution,
    };
  }

  getAbandonedBookings(walletAddress: string) {
    return this.prisma.bookingOrder.findMany({
      where: {
        walletAddress: { equals: walletAddress, mode: "insensitive" },
        status: BookingStatus.EXPIRED as BookingStatus,
        purchase: null,
      },
      include: {
        productVariant: {
          include: {
            product: { select: { id: true, name: true, imageUrl: true, code: true } },
            ProductPrice: {
              where: { isActive: true },
              select: { sellPrice: true, currency: true },
              orderBy: { sellPrice: "asc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
  }

  private async formatBookingResponse(booking: DbBooking) {
    const payment = booking.payment as unknown as BookingPayment;
    const exchangeRateInfo =
      booking.exchangeRate as unknown as BookingExchangeRate;

    const blockchain = await this.blockchainsService.findOne(
      payment.blockchainNetworkId,
    );

    const token = await this.prisma.token.findUnique({
      where: {
        blockchainId_contractAddress: {
          blockchainId: payment.blockchainNetworkId,
          contractAddress: payment.tokenAddress,
        },
      },
    });

    if (!token) {
      throw new NotFoundException(
        `Token with address ${payment.tokenAddress} not found on blockchain ${blockchain.name}`,
      );
    }

    return {
      id: booking.id,
      walletAddress: booking.walletAddress,
      product: {
        id: booking.productVariant.product.id,
        name: booking.productVariant.product.name,
        variant: {
          id: booking.productVariant.id,
          name: booking.productVariant.name,
          variantCode: booking.productVariant.variantCode,
        },
        price: {
          amount: Number(booking.productPrice.sellPrice),
          currency: booking.productPrice.currency,
        },
      },
      payment: {
        token: {
          symbol: token.symbol,
          address: payment.tokenAddress,
          amount: payment.amount,
          blockchainId: blockchain.id,
          blockchainName: blockchain.name,
        },
        exchangeRate: {
          id: exchangeRateInfo.id,
          rate: exchangeRateInfo.rate,
          lockedAt: exchangeRateInfo.lockedAt,
        },
        // Points taken from the buyer's balance, as a string ("0" when none).
        // The token amount above covers only the rest of the price.
        pointsApplied: (booking.pointsApplied ?? 0n).toString(),
      },
      status: booking.status,
      expiresAt: booking.expiresAt.toISOString(),
      createdAt: booking.createdAt.toISOString(),
      executedAt:
        booking.status === BookingStatus.EXECUTED
          ? booking.updatedAt.toISOString()
          : undefined,
    };
  }
}
