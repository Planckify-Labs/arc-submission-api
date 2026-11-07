import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Put,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiTags } from "@nestjs/swagger";
import { BookingService } from "./booking.service";
import { CreateBookingDto } from "./dto/booking.dto";
import { BookingQueryDto } from "./dto/booking-query.dto";
import {
  ApiCreateBooking,
  ApiGetWalletBookings,
  ApiGetLatestBooking,
  ApiGetBookingStats,
  ApiExecuteBooking,
  ApiCancelBooking,
} from "../decorators/swagger/booking.decorators";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { BookingRateLimitGuard } from "./guards/booking-rate-limit.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { addressesEqual } from "../auth/address-compare";
import { Roles } from "../decorators/roles.decorator";
import { UserRole } from "@generated/prisma";
import { assertCallerOwnsWallet } from "./wallet-ownership";

@Controller("bookings")
@ApiTags("bookings")
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "List all bookings (Admin only)" })
  async findAllAdmin(
    @Query() query: BookingQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { items, total } = await this.bookingService.findAllAdmin(query);
    res.setHeader("X-Total-Count", String(total));
    return items;
  }

  @Post()
  @UseGuards(BookingRateLimitGuard)
  @ApiCreateBooking()
  createBooking(
    @Body() createBookingDto: CreateBookingDto,
    @Request() req: { user?: { id?: string; walletAddress?: string | null } },
  ) {
    assertCallerOwnsWallet(req.user, createBookingDto.walletAddress);
    return this.bookingService.createBooking(createBookingDto, req.user?.id);
  }

  @Get("wallet/:walletAddress")
  @UseGuards(JwtAuthGuard)
  @ApiGetWalletBookings()
  getBookings(
    @Param("walletAddress") walletAddress: string,
    @Query() query: BookingQueryDto,
    @Request() req,
  ) {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (
        !addressesEqual(
          req.user.walletAddress,
          walletAddress,
          req.user.addressNamespace,
        )
      ) {
        throw new ForbiddenException("You can only access your own wallet data");
      }
    }
    return this.bookingService.getBookings(walletAddress, query);
  }

  @Get("wallet/:walletAddress/latest")
  @UseGuards(JwtAuthGuard)
  @ApiGetLatestBooking()
  getLatestBooking(
    @Param("walletAddress") walletAddress: string,
    @Request() req,
  ) {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (
        !addressesEqual(
          req.user.walletAddress,
          walletAddress,
          req.user.addressNamespace,
        )
      ) {
        throw new ForbiddenException("You can only access your own wallet data");
      }
    }
    return this.bookingService.getLatestBooking(walletAddress);
  }

  @Get("wallet/:walletAddress/stats")
  @UseGuards(JwtAuthGuard)
  @ApiGetBookingStats()
  getBookingStats(
    @Param("walletAddress") walletAddress: string,
    @Request() req,
  ) {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (
        !addressesEqual(
          req.user.walletAddress,
          walletAddress,
          req.user.addressNamespace,
        )
      ) {
        throw new ForbiddenException("You can only access your own wallet data");
      }
    }
    return this.bookingService.getBookingStats(walletAddress);
  }

  @Get("wallet/:walletAddress/abandoned")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Get abandoned bookings", description: "Expired bookings without a completed purchase - use to show recovery nudges." })
  @ApiResponse({ status: 200, description: "Abandoned bookings list" })
  getAbandonedBookings(
    @Param("walletAddress") walletAddress: string,
    @Request() req,
  ) {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      if (
        !addressesEqual(
          req.user.walletAddress,
          walletAddress,
          req.user.addressNamespace,
        )
      ) {
        throw new ForbiddenException("You can only access your own wallet data");
      }
    }
    return this.bookingService.getAbandonedBookings(walletAddress);
  }

  @Put(":id/execute")
  @UseGuards(JwtAuthGuard)
  @ApiExecuteBooking()
  executeBooking(@Param("id") id: string, @Request() req) {
    return this.bookingService.markBookingExecuted(id, req.user);
  }

  @Put(":id/cancel")
  @UseGuards(JwtAuthGuard)
  @ApiCancelBooking()
  cancelBooking(@Param("id") id: string, @Request() req) {
    return this.bookingService.cancelBooking(id, req.user);
  }
}
