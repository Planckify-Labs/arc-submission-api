import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PointsService } from "./points.service";
import { PointsRefundService } from "./points-refund.service";
import { PointsController } from "./points.controller";
import { PointDepositProcessor } from "./processors/point-deposit.processor";
import { PrismaModule } from "../prisma/prisma.module";
import { ExchangeRateModule } from "../exchange-rate/exchange-rate.module";
import { BlockchainVerificationModule } from "../blockchain-verification/blockchain-verification.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { PushModule } from "../push/push.module";

@Module({
  imports: [
    BullModule.registerQueue({
      name: "point-deposit",
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 3000,
        },
      },
    }),
    PrismaModule,
    ExchangeRateModule,
    BlockchainVerificationModule,
    ValkeyModule,
    PushModule,
  ],
  controllers: [PointsController],
  providers: [PointsService, PointsRefundService, PointDepositProcessor],
  exports: [PointsService, PointsRefundService],
})
export class PointsModule {}
