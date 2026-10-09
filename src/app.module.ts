import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AddressBookModule } from "./address-book/address-book.module";
import { AuditLogsModule } from "./admin/audit-logs/audit-logs.module";
import { AdminMerchantsModule } from "./admin/merchants/admin-merchants.module";
import { AdminPaymentIntentsModule } from "./admin/payment-intents/admin-payment-intents.module";
import { QrisDisputesModule } from "./admin/qris-disputes/qris-disputes.module";
import { AdminFulfilmentModule } from "./admin/fulfilment/admin-fulfilment.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./auth/auth.module";
import { ApiKeyGuard } from "./auth/guards/api-key.guard";
import { JwtAuthGuard } from "./auth/guards/jwt-auth.guard";
import { BlockchainsModule } from "./blockchains/blockchains.module";
import { BookingModule } from "./booking/booking.module";
import { BridgeModule } from "./bridge/bridge.module";
import { OnrampModule } from "./onramp/onramp.module";
import { DappsModule } from "./dapps/dapps.module";
import { SwapModule } from "./swap/swap.module";
import { ExchangeRateModule } from "./exchange-rate/exchange-rate.module";
import { FlashSalesModule } from "./flash-sales/flash-sales.module";
import { MerchantsModule } from "./merchants/merchants.module";
import { NatsModule } from "./nats/nats.module";
import { NftModule } from "./nft/nft.module";
import { PayModule } from "./pay/pay.module";
import { PayoutModule } from "./payout/payout.module";
import { PointsModule } from "./points/points.module";
import { PortfolioModule } from "./portfolio/portfolio.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProductsModule } from "./products/products.module";
import { VendorAPIModule } from "./providers/vendor-api/vendor-api.module";
import { PurchasesModule } from "./purchases/purchases.module";
import { PushModule } from "./push/push.module";
import { QueueModule } from "./queue/queue.module";
import { RedeemModule } from "./redeem/redeem.module";
import { RegionsModule } from "./regions/regions.module";
import { SmartContractsModule } from "./smart-contracts/smart-contracts.module";
import { StatsModule } from "./stats/stats.module";
import { StrategiesModule } from "./strategies/strategies.module";
import { TokensModule } from "./tokens/tokens.module";
import { TransactionsModule } from "./transactions/transactions.module";
import { UserOpModule } from "./userop/userop.module";
import { UsersModule } from "./users/users.module";
import { CacheInterceptor } from "./valkey/interceptors/cache.interceptor";
import { InvalidateCacheInterceptor } from "./valkey/interceptors/invalidate-cache.interceptor";
import { ValkeyModule } from "./valkey/valkey.module";
import { VendorsModule } from "./vendors/vendors.module";
import { WalletActivityModule } from "./wallet-activity/wallet-activity.module";
import { WalletConnectPushModule } from "./walletconnect-push/walletconnect-push.module";
import { X402Module } from "./x402/x402.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ProductsModule,
    UsersModule,
    VendorsModule,
    TransactionsModule,
    TokensModule,
    RegionsModule,
    BlockchainsModule,
    SmartContractsModule,
    PurchasesModule,
    BookingModule,
    ExchangeRateModule,
    VendorAPIModule,
    AuthModule,
    ApiKeysModule,
    ValkeyModule,
    QueueModule,
    DappsModule,
    AddressBookModule,
    PointsModule,
    RedeemModule,
    FlashSalesModule,
    NftModule,
    NatsModule,
    StatsModule,
    X402Module,
    PayModule,
    PayoutModule,
    MerchantsModule,
    QrisDisputesModule,
    AdminFulfilmentModule,
    AdminMerchantsModule,
    AdminPaymentIntentsModule,
    AuditLogsModule,
    UserOpModule,
    StrategiesModule,
    PortfolioModule,
    BridgeModule,
    OnrampModule,
    SwapModule,
    PushModule,
    WalletConnectPushModule,
    WalletActivityModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: InvalidateCacheInterceptor,
    },
  ],
})
export class AppModule {}
