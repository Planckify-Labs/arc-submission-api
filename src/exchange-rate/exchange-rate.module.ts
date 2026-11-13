import { Module } from "@nestjs/common";
import { ExchangeRateController } from "./exchange-rate.controller";
import { ExchangeRateService } from "./exchange-rate.service";
import { ChainlinkFxSyncService } from "./chainlink/chainlink-fx-sync.service";
import { PrismaModule } from "../prisma/prisma.module";
import { ValkeyModule } from "../valkey/valkey.module";

@Module({
  imports: [PrismaModule, ValkeyModule],
  controllers: [ExchangeRateController],
  providers: [ExchangeRateService, ChainlinkFxSyncService],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
