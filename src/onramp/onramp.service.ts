/**
 * Onramp service: config view, session minting, order ledger.
 *
 * Spec: mobile-app docs/onramp-app-kit-spec.md §5.
 */

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { addressesEqual } from "../auth/address-compare";
import type { AddressNamespace } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { PushService } from "../push/push.service";
import { canonicalizeWalletAddress } from "../utils/address";
import { RateLimitCacheService } from "../valkey/services/rate-limit-cache.service";
import { ValkeyService } from "../valkey/valkey.service";
import { walletActivityDedupeKey } from "../wallet-activity/wallet-activity.classifier";
import {
  OnrampKitClient,
  OnrampMintError,
  type OnrampSessionView,
} from "./onramp-kit.client";
import type { NormalizedOnrampUpdate } from "./onramp-webhook";
import {
  type OnrampConfig,
  type OnrampDisabledReason,
  type OnrampEnvironment,
  resolveOnrampConfig,
} from "./onramp.config";

/** What `GET /onramp/config` returns. Never carries the key or widgetChain. */
export interface OnrampConfigView {
  enabled: boolean;
  disabledReason: OnrampDisabledReason | null;
  environment: OnrampEnvironment;
  widgetBaseUrl: string;
  hostedPageUrl: string | null;
  support: { chainKey: string; tokens: string[] }[];
  externalLinkHosts: string[];
}

export interface OnrampAuthUser {
  id: string;
  walletAddress?: string;
  addressNamespace?: AddressNamespace;
}

/** Fixed labels only. The mobile app maps these to its own copy (§8). */
const ERR = {
  disabled: { message: "Onramp unavailable", code: "ONRAMP_DISABLED" },
  unsupportedChain: {
    message: "Chain not supported for onramp",
    code: "ONRAMP_UNSUPPORTED_CHAIN",
  },
  notOwnWallet: {
    message: "Destination is not this account's wallet",
    code: "ONRAMP_DESTINATION_NOT_OWNED",
  },
  rateLimited: {
    message: "Too many onramp sessions",
    code: "ONRAMP_RATE_LIMITED",
  },
  mintFailed: { message: "Could not start onramp", code: "ONRAMP_MINT_FAILED" },
} as const;

/** `KitError.type` → HTTP (§2.4): INPUT 400, RATE_LIMIT 429, NETWORK 504, SERVICE/RPC 502, else 500. */
function mintFailureStatus(err: OnrampMintError): HttpStatus {
  switch (err.kind) {
    case "input":
      return HttpStatus.BAD_REQUEST;
    case "rate_limit":
      return HttpStatus.TOO_MANY_REQUESTS;
    case "network":
      return HttpStatus.GATEWAY_TIMEOUT;
    case "upstream":
      return HttpStatus.BAD_GATEWAY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

function namespaceOfChainKey(chainKey: string): string {
  return chainKey.slice(0, chainKey.indexOf(":"));
}

@Injectable()
export class OnrampService {
  private readonly logger = new Logger(OnrampService.name);
  private readonly config: OnrampConfig;

  constructor(
    configService: ConfigService,
    private readonly kit: OnrampKitClient,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitCacheService,
    private readonly valkey: ValkeyService,
    @Inject(PushService) private readonly push: PushService,
  ) {
    this.config = resolveOnrampConfig((k) => configService.get<string>(k));
    this.logger.log(
      `[onramp] env=${this.config.environment} enabled=${this.config.enabled} chains=${this.config.support.map((s) => s.chainKey).join(",") || "none"} page=${this.config.hostedPageUrl ?? "none"}`,
    );
  }

  getConfigView(): OnrampConfigView {
    const c = this.config;
    return {
      enabled: c.enabled,
      disabledReason: c.disabledReason,
      environment: c.environment,
      widgetBaseUrl: c.widgetBaseUrl,
      hostedPageUrl: c.hostedPageUrl,
      // Sent whenever the flag is on, even before a key or hosted page is
      // configured, so a debug build can preview the Buy screen (`enabled`
      // still says whether checkout can actually run).
      support:
        c.disabledReason === "flag_off"
          ? []
          : c.support.map((s) => ({ chainKey: s.chainKey, tokens: s.tokens })),
      externalLinkHosts: c.externalLinkHosts,
    };
  }

  /**
   * Mint a session for the caller's OWN wallet (§5.3).
   *
   * One User row is one wallet here (SIWx), and the app calls with the
   * JWT of the wallet that will receive the funds (payment JWT binding).
   * So "a wallet owned by that user" is exactly `user.walletAddress`, on a
   * chain whose namespace matches the JWT's. Anything else is refused:
   * that is what stops a session minted for someone else's address.
   */
  async createSession(
    user: OnrampAuthUser,
    input: { destinationAddress: string; chainKey: string },
  ): Promise<OnrampSessionView> {
    const c = this.config;
    if (!c.enabled) throw new ServiceUnavailableException(ERR.disabled);

    const support = c.support.find((s) => s.chainKey === input.chainKey);
    if (!support) throw new BadRequestException(ERR.unsupportedChain);

    const namespace = namespaceOfChainKey(support.chainKey);
    if (
      !user.walletAddress ||
      (user.addressNamespace ?? "eip155") !== namespace ||
      !addressesEqual(
        input.destinationAddress,
        user.walletAddress,
        namespace as AddressNamespace,
      )
    ) {
      throw new BadRequestException(ERR.notOwnWallet);
    }

    const rl = await this.rateLimit.checkRateLimit(
      `onramp:session:${user.id}`,
      c.sessionsPerWindow,
      c.sessionWindowMs,
    );
    if (!rl.allowed) {
      throw new HttpException(ERR.rateLimited, HttpStatus.TOO_MANY_REQUESTS);
    }

    const walletAddress = canonicalizeWalletAddress(
      user.walletAddress,
      namespace as AddressNamespace,
    );

    let session: OnrampSessionView;
    try {
      session = await this.kit.mintSession(c, {
        appUserId: user.id,
        destinationAddress: walletAddress,
        // Built from server support, never from the client (§5.3).
        assets: {
          pairs: support.tokens.map((token) => ({
            token,
            chain: support.widgetChain,
          })),
        },
      });
    } catch (err) {
      if (err instanceof OnrampMintError) {
        this.logger.warn(
          `[onramp] session user=${user.id} env=${c.environment} outcome=failed kind=${err.kind}`,
        );
        throw new HttpException(ERR.mintFailed, mintFailureStatus(err));
      }
      throw err;
    }

    // Ledger row. A failure here must not cost the user their purchase:
    // the widget still delivers on-chain, and the app reads the chain.
    try {
      await this.prisma.onrampOrder.create({
        data: {
          userId: user.id,
          walletAddress,
          chainKey: support.chainKey,
          env: c.environment,
          sessionId: session.sessionId,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[onramp] order row not written for session of user=${user.id}: ${err instanceof Error ? err.name : "unknown"}`,
      );
    }

    this.logger.log(
      `[onramp] session user=${user.id} env=${c.environment} chain=${support.chainKey} outcome=minted`,
    );
    return session;
  }

  /**
   * Apply one verified webhook update. Idempotent: duplicate deliveries
   * are dropped on `notificationId`, and a status never moves backwards
   * (SETTLED and FAILED are terminal).
   */
  async applyUpdate(update: NormalizedOnrampUpdate): Promise<void> {
    if (update.notificationId) {
      const seen = await this.valkey.incr(
        `onramp:webhook:${update.notificationId}`,
      );
      if (seen === 1) {
        void this.valkey
          .expire(`onramp:webhook:${update.notificationId}`, 7 * 24 * 3600)
          .catch(() => undefined);
      } else {
        return;
      }
    }

    const order = await this.prisma.onrampOrder.findFirst({
      where: update.sessionId
        ? { sessionId: update.sessionId }
        : { orderId: update.orderId ?? undefined },
    });
    if (!order) {
      this.logger.warn("[onramp] webhook for an unknown order, ignored");
      return;
    }
    if (order.status === "SETTLED" || order.status === "FAILED") return;
    if (update.transition === "submitted" && order.status === "SUBMITTED")
      return;

    const status =
      update.transition === "settled"
        ? "SETTLED"
        : update.transition === "failed"
          ? "FAILED"
          : "SUBMITTED";

    const updated = await this.prisma.onrampOrder.update({
      where: { id: order.id },
      data: {
        status,
        orderId: update.orderId ?? order.orderId,
        txHash: update.txHash ?? order.txHash,
        amount: update.amount ?? order.amount,
        token: update.token ?? order.token,
        failureCode: update.failureCode,
        settledAt: status === "SETTLED" ? new Date() : undefined,
      },
    });

    if (status === "SETTLED") await this.sendSettledPush(updated);
  }

  private async sendSettledPush(order: {
    id: string;
    walletAddress: string;
    txHash: string | null;
    amount: string | null;
    token: string | null;
  }): Promise<void> {
    const what =
      order.amount && order.token
        ? `${order.amount} ${order.token}`
        : (order.token ?? "Your funds");
    try {
      await this.push.sendToWallet({
        walletAddress: order.walletAddress,
        title: "Funds added",
        body: `${what} arrived in your wallet.`,
        data: { type: "onramp_settled", orderId: order.id },
        channelId: "transfers",
        source: "onramp",
        // Same key as the inbound-transfer push for this tx, so the user
        // hears about the arrival once whichever producer is first.
        dedupeKey: order.txHash
          ? walletActivityDedupeKey(order.txHash, order.walletAddress)
          : `onramp:${order.id}`,
      });
    } catch (err) {
      this.logger.warn(
        `[onramp] settled push failed for order=${order.id}: ${err instanceof Error ? err.name : "unknown"}`,
      );
    }
  }
}
