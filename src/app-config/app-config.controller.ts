import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../decorators/public.decorator";
import { AppConfigService, type AppConfigView } from "./app-config.service";

@ApiTags("app-config")
@Controller("app-config")
export class AppConfigController {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Public and not API-key gated on purpose: it carries no secret, and the
   * app reads it before it has a session. The mode only decides what clients
   * offer; it does not gate /bookings, /purchases, /redeem or /points.
   */
  @Get()
  @Public()
  @ApiOperation({
    summary: "Client-facing runtime config (how products are paid for)",
  })
  getConfig(): Promise<AppConfigView> {
    return this.appConfig.getConfig();
  }
}
