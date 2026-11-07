import { Module } from "@nestjs/common";
import { BookingService } from "./booking.service";
import { BookingController } from "./booking.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { ConfigModule } from "@nestjs/config";
import { BlockchainsModule } from "../blockchains/blockchains.module";
import { ProductsModule } from "../products/products.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { PushModule } from "../push/push.module";
import { BookingReminderService } from "./booking-reminder.service";
import { BookingExpiryService } from "./booking-expiry.service";
import { PointsHoldModule } from "../points-hold/points-hold.module";
import { ExchangeRateModule } from "../exchange-rate/exchange-rate.module";

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    BlockchainsModule,
    ProductsModule,
    ValkeyModule,
    PushModule,
    ExchangeRateModule,
    PointsHoldModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingReminderService, BookingExpiryService],
  exports: [BookingService],
})
export class BookingModule {}
