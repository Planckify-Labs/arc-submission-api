/**
 * `/onramp/*` (mobile-app docs/onramp-app-kit-spec.md §5.2).
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Public } from "../decorators/public.decorator";
import { CreateOnrampSessionDto } from "./dto/onramp.dto";
import type { OnrampSessionView } from "./onramp-kit.client";
import {
  ONRAMP_WEBHOOK_VERIFIER,
  type OnrampWebhookVerifier,
  normalizeOnrampWebhook,
} from "./onramp-webhook";
import {
  type OnrampAuthUser,
  type OnrampConfigView,
  OnrampService,
} from "./onramp.service";

@ApiTags("onramp")
@Controller("onramp")
export class OnrampController {
  private readonly logger = new Logger(OnrampController.name);

  constructor(
    private readonly onramp: OnrampService,
    @Inject(ONRAMP_WEBHOOK_VERIFIER)
    private readonly verifier: OnrampWebhookVerifier,
  ) {}

  @Get("config")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      "Whether Buy is available and on which chains. Drives tab visibility; doubles as the kill switch.",
  })
  getConfig(): OnrampConfigView {
    return this.onramp.getConfigView();
  }

  @Post("sessions")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Mint a 30-minute widget session for the caller's own wallet. Never cached.",
  })
  async createSession(
    @Req() req: { user: OnrampAuthUser },
    @Body() dto: CreateOnrampSessionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OnrampSessionView> {
    res.setHeader("Cache-Control", "no-store");
    return this.onramp.createSession(req.user, {
      destinationAddress: dto.destinationAddress,
      chainKey: dto.chainKey,
    });
  }

  @Post("webhook")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Provider order-state webhook. Inert (503) until the signature scheme is known (spec Q2).",
  })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const verdict = await this.verifier.verify({
      rawBody: req.rawBody,
      headers,
    });
    if (!verdict.ok) {
      if (verdict.reason === "not_configured") {
        throw new ServiceUnavailableException({
          message: "Webhook not configured",
          code: "ONRAMP_WEBHOOK_NOT_CONFIGURED",
        });
      }
      this.logger.warn("[onramp-webhook] rejected: invalid signature");
      throw new UnauthorizedException({
        message: "Invalid webhook signature.",
        code: "WEBHOOK_SIGNATURE_INVALID",
      });
    }

    const update = normalizeOnrampWebhook(body);
    if (!update) return { ok: true };
    // Respond fast, process after (§5.4).
    void this.onramp.applyUpdate(update).catch((err) => {
      this.logger.warn(
        `[onramp-webhook] apply failed: ${err instanceof Error ? err.name : "unknown"}`,
      );
    });
    return { ok: true };
  }
}
