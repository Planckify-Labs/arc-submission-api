import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { ExecutionContext } from "@nestjs/common";
import { assertCallerOwnsWallet } from "./wallet-ownership";
import { BookingRateLimitGuard } from "./guards/booking-rate-limit.guard";
import type { RateLimitCacheService } from "../valkey/services/rate-limit-cache.service";

const EVM = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER_EVM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("assertCallerOwnsWallet", () => {
  it("accepts the session wallet, whatever the address casing", () => {
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: EVM }, EVM.toLowerCase()),
    ).not.toThrow();
  });

  it("rejects someone else's wallet with a 400 before any money moves", () => {
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: EVM }, OTHER_EVM),
    ).toThrow(BadRequestException);
  });

  it("rejects a session with no wallet (email-only Google token)", () => {
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: undefined }, EVM),
    ).toThrow(BadRequestException);
    expect(() => assertCallerOwnsWallet(undefined, EVM)).toThrow(
      BadRequestException,
    );
  });

  it("does not accept a different wallet family's address", () => {
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: EVM }, SOLANA),
    ).toThrow(BadRequestException);
  });

  it("compares Solana addresses verbatim (case-sensitive)", () => {
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: SOLANA }, SOLANA),
    ).not.toThrow();
    expect(() =>
      assertCallerOwnsWallet({ walletAddress: SOLANA }, SOLANA.toLowerCase()),
    ).toThrow(BadRequestException);
  });
});

describe("BookingRateLimitGuard ownership", () => {
  const build = () => {
    const rateLimit = {
      checkRateLimit: jest.fn(async () => ({ allowed: true })),
    };
    const guard = new BookingRateLimitGuard(
      rateLimit as unknown as RateLimitCacheService,
      { get: jest.fn() } as unknown as ConfigService,
    );
    const ctx = (user: unknown, walletAddress: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user, body: { walletAddress } }),
        }),
      }) as unknown as ExecutionContext;
    return { guard, rateLimit, ctx };
  };

  it("does not spend a victim's booking quota for a caller who does not own the wallet", async () => {
    const { guard, rateLimit, ctx } = build();
    await expect(
      guard.canActivate(ctx({ walletAddress: OTHER_EVM }, EVM)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rateLimit.checkRateLimit).not.toHaveBeenCalled();
  });

  it("counts the owner's own bookings", async () => {
    const { guard, rateLimit, ctx } = build();
    await expect(
      guard.canActivate(ctx({ walletAddress: EVM }, EVM)),
    ).resolves.toBe(true);
    expect(rateLimit.checkRateLimit).toHaveBeenCalledTimes(1);
  });
});
