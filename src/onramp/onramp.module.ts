/**
 * Onramp module (mobile-app docs/onramp-app-kit-spec.md §5).
 *
 * The webhook verifier is bound here. It stays the rejecting placeholder
 * until the provider documents the signature scheme (spec Q2); swapping
 * in the real one is a one-line change to `useClass`.
 */

import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PushModule } from "../push/push.module";
import { ValkeyModule } from "../valkey/valkey.module";
import { OnrampKitClient } from "./onramp-kit.client";
import {
  ONRAMP_WEBHOOK_VERIFIER,
  UnconfiguredOnrampWebhookVerifier,
} from "./onramp-webhook";
import { OnrampController } from "./onramp.controller";
import { OnrampService } from "./onramp.service";

@Module({
  imports: [PrismaModule, ValkeyModule, PushModule],
  controllers: [OnrampController],
  providers: [
    OnrampService,
    OnrampKitClient,
    {
      provide: ONRAMP_WEBHOOK_VERIFIER,
      useClass: UnconfiguredOnrampWebhookVerifier,
    },
  ],
})
export class OnrampModule {}
