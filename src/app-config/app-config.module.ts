import { Module } from "@nestjs/common";
import { ExchangeRateModule } from "../exchange-rate/exchange-rate.module";
import { AppConfigController } from "./app-config.controller";
import { AppConfigService } from "./app-config.service";

@Module({
  imports: [ExchangeRateModule],
  controllers: [AppConfigController],
  providers: [AppConfigService],
})
export class AppConfigModule {}
