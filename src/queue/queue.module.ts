import { PointsHoldModule } from "../points-hold/points-hold.module";
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PurchaseProcessor } from "./processors/purchase.processor";
import { PrismaModule } from "../prisma/prisma.module";
import { BlockchainVerificationModule } from "../blockchain-verification/blockchain-verification.module";
import { VendorAPIModule } from "../providers/vendor-api/vendor-api.module";
import { ReferenceIdModule } from "../reference-id/reference-id.module";
import { QueueService } from "./queue.service";
import { ValkeyModule } from "../valkey/valkey.module";
import { PushModule } from "../push/push.module";
import { FulfilmentModule } from "../fulfilment/fulfilment.module";

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const password = configService.get<string>("VALKEY_PASSWORD");
        return {
          connection: {
            host: configService.get<string>("VALKEY_HOST", "localhost"),
            port: configService.get<number>("VALKEY_PORT", 6379),
            ...(password && { password }),
            retryDelayOnFailover: 100,
            enableReadyCheck: false,
            maxRetriesPerRequest: null,
            lazyConnect: true,
          },
          defaultJobOptions: {
            // Keep completed jobs for 1 hour (audit trail + debugging)
            removeOnComplete: { age: 3600, count: 1000 },
            // Keep failed jobs for 24 hours (post-mortem analysis)
            removeOnFail: { age: 86400, count: 500 },
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 2000,
            },
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      {
        name: "purchase-processing",
        defaultJobOptions: {
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 500 },
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        },
      },
      {
        name: "blockchain-verification",
        defaultJobOptions: {
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 500 },
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
        },
      },
      {
        name: "vendor-api-calls",
        defaultJobOptions: {
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 500 },
          attempts: 3,
          backoff: { type: "exponential", delay: 3000 },
        },
      },
    ),
    PrismaModule,
    BlockchainVerificationModule,
    VendorAPIModule,
    ReferenceIdModule,
    ValkeyModule,
    PushModule,
    FulfilmentModule,
    PointsHoldModule,
  ],
  providers: [PurchaseProcessor, QueueService],
  exports: [QueueService],
})
export class QueueModule {}
