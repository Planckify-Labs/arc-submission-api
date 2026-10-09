/**
 * Arc App Kit Onramp, server half (session minting).
 *
 * Spec: mobile-app docs/onramp-app-kit-spec.md §2.4, §5.3.
 *
 * THE ONLY FILE IN THIS REPO THAT IMPORTS `@circle-fin/app-kit/server`.
 * Nest is not a Fetch-API host, so per the docs we call
 * `server.onramp.createSession()` directly instead of mounting
 * `createSessionRouteHandler`, and map `KitError.type` to HTTP ourselves.
 *
 * Verified against the shipped types of `@circle-fin/app-kit@1.15.3`
 * (`server.d.ts`) and `@circle-fin/onramp-kit@1.0.3`, 2026-10-08.
 */

import {
  type AppServerKit,
  createAppServerKit,
  KitError,
  type MintedOnrampSession,
} from "@circle-fin/app-kit/server";
import { Injectable, Logger } from "@nestjs/common";
import type { OnrampConfig } from "./onramp.config";

export interface MintSessionInput {
  appUserId: string;
  destinationAddress: string;
  assets: { pairs: { token: string; chain: string }[] };
}

/**
 * The only session fields that leave the server. `createSession` already
 * allow-lists its output; this narrows it again to what the widget needs
 * so an upstream addition can never ride along to the device.
 */
export interface OnrampSessionView {
  sessionId: string;
  sessionToken: string;
  widgetUrl: string;
  expiresAt: string;
  traceId: string;
}

/** Our closed vocabulary for a failed mint (§2.4 mapping). */
export type OnrampMintFailure =
  | "input"
  | "rate_limit"
  | "network"
  | "upstream"
  | "unknown";

export class OnrampMintError extends Error {
  constructor(
    readonly kind: OnrampMintFailure,
    /** Stable numeric kit code, for logs and the 1907 alert only. */
    readonly kitCode: number | null,
  ) {
    super(`onramp_mint_${kind}`);
    this.name = "OnrampMintError";
  }
}

/** `KitError.type` → our vocabulary. Branch on type, not name/code (§2.6). */
export function classifyKitError(err: unknown): OnrampMintError {
  if (err instanceof KitError) {
    const kind: OnrampMintFailure =
      err.type === "INPUT"
        ? "input"
        : err.type === "RATE_LIMIT"
          ? "rate_limit"
          : err.type === "NETWORK"
            ? "network"
            : err.type === "SERVICE" || err.type === "RPC"
              ? "upstream"
              : "unknown";
    return new OnrampMintError(kind, err.code);
  }
  return new OnrampMintError("unknown", null);
}

/** Onramp error code for an invalid API key (§2.6). Alert-worthy. */
export const KIT_CODE_INVALID_API_KEY = 1907;

@Injectable()
export class OnrampKitClient {
  private readonly logger = new Logger(OnrampKitClient.name);
  private kit: AppServerKit | null = null;
  private kitFor: OnrampConfig | null = null;

  private getKit(config: OnrampConfig): AppServerKit {
    if (!config.apiKey) throw new OnrampMintError("unknown", null);
    if (this.kit && this.kitFor === config) return this.kit;
    this.kit = createAppServerKit({
      onramp: {
        apiKey: config.apiKey,
        baseUrl: config.apiBaseUrl,
        widgetBaseUrl: config.widgetBaseUrl,
        // From env config only, never a request header (§2.4).
        referrerDomain: config.referrerDomain ?? undefined,
      },
    });
    this.kitFor = config;
    return this.kit;
  }

  async mintSession(
    config: OnrampConfig,
    input: MintSessionInput,
  ): Promise<OnrampSessionView> {
    let session: MintedOnrampSession;
    try {
      session = await this.getKit(config).onramp.createSession({
        appUserId: input.appUserId,
        destinationAddress: input.destinationAddress,
        assets: input.assets,
      });
    } catch (err) {
      const mapped = classifyKitError(err);
      // Never log the key or a session token. The kit's message is a
      // diagnostic that can carry upstream text, so only type + code.
      this.logger.warn(
        `[onramp] createSession failed kind=${mapped.kind} code=${mapped.kitCode ?? "n/a"}`,
      );
      if (mapped.kitCode === KIT_CODE_INVALID_API_KEY) {
        this.logger.error(
          "[onramp] ALERT INPUT_INVALID_API_KEY: the onramp API key was rejected",
        );
      }
      throw mapped;
    }

    if (
      typeof session.sessionId !== "string" ||
      typeof session.sessionToken !== "string" ||
      typeof session.widgetUrl !== "string" ||
      typeof session.expiresAt !== "string"
    ) {
      this.logger.warn("[onramp] createSession returned an incomplete session");
      throw new OnrampMintError("upstream", null);
    }

    return {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      widgetUrl: session.widgetUrl,
      expiresAt: session.expiresAt,
      traceId: session.traceId,
    };
  }
}
