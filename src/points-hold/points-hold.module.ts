import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { PointsHoldService } from "./points-hold.service";

/** Deliberately tiny and dependency-light so Booking, Queue and Fulfilment can all import it without a cycle. */
@Module({
  imports: [PrismaModule, ValkeyModule],
  providers: [PointsHoldService],
  exports: [PointsHoldService],
})
export class PointsHoldModule {}
