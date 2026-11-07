import type { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import type { ExchangeRateService } from "../exchange-rate/exchange-rate.service";
import { AppConfigController } from "./app-config.controller";
import {
  AppConfigService,
  resolveProductPaymentMode,
} from "./app-config.service";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { IS_API_KEY_REQUIRED } from "../decorators/api-key.decorator";

const noRates = { findLatest: jest.fn(async () => null) };
const serviceFor = (value: string | undefined, rates: unknown = noRates) =>
  new AppConfigService(
    { get: jest.fn(() => value) } as unknown as ConfigService,
    rates as ExchangeRateService,
  );

describe("resolveProductPaymentMode", () => {
  it.each([
    [undefined, "TOKEN"],
    ["", "TOKEN"],
    ["   ", "TOKEN"],
    ["TOKEN", "TOKEN"],
    ["POINTS", "POINTS"],
    ["points", "POINTS"],
  ])("%j -> %s", (raw, expected) => {
    expect(resolveProductPaymentMode(raw)).toBe(expected);
  });

  it("reports an invalid value and falls back to TOKEN", () => {
    const onInvalid = jest.fn();
    expect(resolveProductPaymentMode("CASH", onInvalid)).toBe("TOKEN");
    expect(onInvalid).toHaveBeenCalledWith("CASH");
  });

  it("does not report the unset / empty cases", () => {
    const onInvalid = jest.fn();
    resolveProductPaymentMode("", onInvalid);
    resolveProductPaymentMode(undefined, onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});

describe("AppConfigService", () => {
  it("serves the configured mode", async () => {
    await expect(serviceFor("POINTS").getConfig()).resolves.toMatchObject({
      productPayment: { mode: "POINTS", minTokenRemainderUsd: 0.3 },
    });
  });

  it("defaults to TOKEN when unset or empty", async () => {
    expect((await serviceFor(undefined).getConfig()).productPayment.mode).toBe("TOKEN");
    expect((await serviceFor("").getConfig()).productPayment.mode).toBe("TOKEN");
  });

  it("warns and uses TOKEN for an invalid value instead of throwing", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    expect(() => serviceFor("nonsense")).not.toThrow();
    expect((await serviceFor("nonsense").getConfig()).productPayment.mode).toBe(
      "TOKEN",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nonsense"));
    warn.mockRestore();
  });
});

describe("AppConfigController", () => {
  it("is public (skips JWT) and does not require an API key", () => {
    const handler = AppConfigController.prototype.getConfig;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(IS_API_KEY_REQUIRED, handler)).toBeUndefined();
  });

  it("returns the service view", async () => {
    const controller = new AppConfigController(serviceFor("POINTS"));
    await expect(controller.getConfig()).resolves.toEqual({
      productPayment: {
        mode: "POINTS",
        minTokenRemainderUsd: 0.3,
        idrPerUsd: null,
      },
    });
  });
});

describe("AppConfigService USD reference", () => {
  const ratesFor = (table: Record<string, unknown>) => ({
    findLatest: jest.fn(async ({ fromCurrency }: { fromCurrency: string }) => {
      const row = table[fromCurrency];
      if (row instanceof Error) throw row;
      return row ?? null;
    }),
  });
  const idrPerUsd = async (table: Record<string, unknown>) =>
    (await serviceFor("TOKEN", ratesFor(table)).getConfig()).productPayment
      .idrPerUsd;

  it("prefers USDC", async () => {
    await expect(
      idrPerUsd({
        USDC: { rate: 16000, isActive: true },
        AUSD: { rate: 17690, isActive: true },
      }),
    ).resolves.toBe(16000);
  });

  it("falls through to another USD stablecoin when USDC has no rate", async () => {
    await expect(
      idrPerUsd({ AUSD: { rate: 17690, isActive: true } }),
    ).resolves.toBe(17690);
  });

  it("skips inactive rows and failed lookups", async () => {
    await expect(
      idrPerUsd({
        USDC: { rate: 16000, isActive: false },
        USDT: new Error("cache down"),
        AUSD: { rate: 17690, isActive: true },
      }),
    ).resolves.toBe(17690);
  });

  it("is null when nothing has a rate", async () => {
    await expect(idrPerUsd({})).resolves.toBeNull();
  });
});
