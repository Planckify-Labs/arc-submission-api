import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorAPIModule } from "../providers/vendor-api/vendor-api.module";
import { PushModule } from "../push/push.module";
import { DeliveryModule } from "../delivery/delivery.module";
import { PointsModule } from "../points/points.module";
import { PointsHoldModule } from "../points-hold/points-hold.module";
import { FulfilmentService } from "./fulfilment.service";
import { FulfilmentProcessor } from "./fulfilment.processor";
import { FulfilmentSweeperService } from "./fulfilment-sweeper.service";
import { FULFILMENT_QUEUE } from "./fulfilment.types";

@Module({
  imports: [
    BullModule.registerQueue({
      name: FULFILMENT_QUEUE,
      defaultJobOptions: {
        // A throw here is our bug, not "vendor still pending" — that path
        // reschedules itself. Three tries, then the sweeper picks it up.
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 500 },
      },
    }),
    PrismaModule,
    VendorAPIModule,
    PushModule,
    DeliveryModule,
    PointsModule,
    PointsHoldModule,
  ],
  providers: [FulfilmentService, FulfilmentProcessor, FulfilmentSweeperService],
  exports: [FulfilmentService],
})
export class FulfilmentModule {}
