import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PushModule } from "../push/push.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { AlchemyPricesClient } from "./external/alchemy-prices.client";
import { DeBankClient } from "./external/debank.client";
import { DeFiLlamaClient } from "./external/defillama.client";
import { MarketRiskClient } from "./external/market-risk.client";
import { LifiClient } from "./external/lifi.client";
import { SuiLstSource } from "./external/sui-lst.source";
import { ZerionModule } from "../external/zerion";
import { RecurringInvestService } from "./recurring-invest.service";
import { RouterQuoteService } from "./router-quote.service";
import { ScoringService } from "./scoring/scoring.service";
import { StrategiesController } from "./strategies.controller";
import { StrategiesScheduler } from "./strategies.scheduler";
import { StrategiesService } from "./strategies.service";
import { TargetResolverService } from "./targets/target-resolver.service";
import { AsyncClaimWatcherProcessor } from "./workers/async-claim-watcher.processor";
import { AutoCompoundWatcherProcessor } from "./workers/auto-compound-watcher.processor";
import { DefiLlamaPollProcessor } from "./workers/defillama-poll.processor";
import { GoalDeadlineWatcherProcessor } from "./workers/goal-deadline-watcher.processor";
import { RebalanceTriggerProcessor } from "./workers/rebalance-trigger.processor";
import { RecurringInvestWatcherProcessor } from "./workers/recurring-invest-watcher.processor";
import { ScoreOpportunitiesProcessor } from "./workers/score-opportunities.processor";
import { StablecoinDepegWatcherProcessor } from "./workers/stablecoin-depeg-watcher.processor";

@Module({
  imports: [
    PrismaModule,
    ValkeyModule,
    PushModule,
    ZerionModule,
    BullModule.registerQueue(
      { name: "defillama-poll" },
      { name: "score-opportunities" },
      { name: "stablecoin-depeg-watcher" },
      { name: "rebalance-trigger" },
      { name: "goal-deadline-watcher" },
      { name: "auto-compound-watcher" },
      // ERC-7540 pending-claims tracker (expansion spec §7).
      { name: "async-claim-watcher" },
      // DCA v1 recurring-invest reminders (quick-invest spec §12.4).
      { name: "recurring-invest-watcher" },
    ),
  ],
  controllers: [StrategiesController],
  providers: [
    StrategiesService,
    StrategiesScheduler,
    DeFiLlamaClient,
    SuiLstSource,
    LifiClient,
    DeBankClient,
    AlchemyPricesClient,
    MarketRiskClient,
    ScoringService,
    RouterQuoteService,
    RecurringInvestService,
    TargetResolverService,
    DefiLlamaPollProcessor,
    ScoreOpportunitiesProcessor,
    StablecoinDepegWatcherProcessor,
    RebalanceTriggerProcessor,
    GoalDeadlineWatcherProcessor,
    AutoCompoundWatcherProcessor,
    AsyncClaimWatcherProcessor,
    RecurringInvestWatcherProcessor,
  ],
  exports: [StrategiesService, ScoringService, RecurringInvestService],
})
export class StrategiesModule {}
