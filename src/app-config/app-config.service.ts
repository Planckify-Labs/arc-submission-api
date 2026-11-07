import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExchangeRateService } from "../exchange-rate/exchange-rate.service";
import { MIN_TOKEN_REMAINDER_USD } from "../points-hold/points-allocation";

export type ProductPaymentMode = "TOKEN" | "POINTS";

export interface AppConfigView {
  productPayment: {
    mode: ProductPaymentMode;
    /** Least a buyer still pays in tokens when using points (USD). Single source: points-allocation.ts. */
    minTokenRemainderUsd: number;
    /** IDR per USD for price displays; null when no USD stablecoin has a rate. */
    idrPerUsd: number | null;
  };
}

/** USD stablecoins that can stand in for USD, preferred first. */
export const USD_REFERENCE_TOKENS = ["USDC", "USDT", "USDG", "AUSD"];

export const DEFAULT_PRODUCT_PAYMENT_MODE: ProductPaymentMode = "TOKEN";

/**
 * Resolves `PRODUCT_PAYMENT_MODE`. Empty means unset (compose forwards empty
 * values), and an unrecognised value falls back to the default with a
 * warning: a typo in an env var must not stop the API from booting.
 */
export function resolveProductPaymentMode(
  raw: string | undefined | null,
  onInvalid?: (value: string) => void,
): ProductPaymentMode {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_PRODUCT_PAYMENT_MODE;
  const upper = value.toUpperCase();
  if (upper === "TOKEN" || upper === "POINTS") return upper;
  onInvalid?.(value);
  return DEFAULT_PRODUCT_PAYMENT_MODE;
}

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);
  private readonly mode: ProductPaymentMode;

  constructor(
    config: ConfigService,
    private readonly exchangeRates: ExchangeRateService,
  ) {
    this.mode = resolveProductPaymentMode(
      config.get<string>("PRODUCT_PAYMENT_MODE"),
      (value) =>
        this.logger.warn(
          `PRODUCT_PAYMENT_MODE="${value}" is not TOKEN or POINTS; using ${DEFAULT_PRODUCT_PAYMENT_MODE}`,
        ),
    );
  }

  async getConfig(): Promise<AppConfigView> {
    return {
      productPayment: {
        mode: this.mode,
        minTokenRemainderUsd: MIN_TOKEN_REMAINDER_USD,
        idrPerUsd: await this.resolveIdrPerUsd(),
      },
    };
  }

  /** A missing rate on one stablecoin must not blank every price in the app. */
  private async resolveIdrPerUsd(): Promise<number | null> {
    for (const fromCurrency of USD_REFERENCE_TOKENS) {
      try {
        const row = await this.exchangeRates.findLatest({
          fromCurrency,
          toCurrency: "IDR",
        });
        if (row?.isActive && row.rate > 0) return Number(row.rate);
      } catch (err) {
        this.logger.warn(
          `[app-config] ${fromCurrency} rate lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn("[app-config] no USD stablecoin has an IDR rate");
    return null;
  }
}
