import { Prisma } from "@generated/prisma";

/**
 * The least a buyer must still pay in tokens when part of a product is paid
 * with points (USD). The ONLY place this number lives: `GET /app-config`
 * serves it as `productPayment.minTokenRemainderUsd`, and the booking
 * allocation below uses the same constant.
 */
export const MIN_TOKEN_REMAINDER_USD = 0.3;

// Exact enough that ceil() is never fooled by a rounded intermediate.
const D = Prisma.Decimal.clone({ precision: 60 });

/**
 * How many points a booking takes from the balance. Prices are IDR and 1
 * point = Rp 1; `rate` is IDR per token.
 *
 *   fullPoints      = ceil(sellPrice)
 *   minRemainderIdr = ceil(MIN_TOKEN_REMAINDER_USD x rate)
 *   applied         = min(balance, fullPoints - minRemainderIdr), 0 if <= 0
 *
 * A balance that covers the whole price still leaves the minimum in tokens;
 * paying fully with points stays on `/redeem`.
 */
export function computePointsApplied(input: {
  sellPrice: Prisma.Decimal | string | number;
  rate: Prisma.Decimal | string | number;
  balance: bigint;
}): bigint {
  const fullPoints = BigInt(
    new D(input.sellPrice.toString()).toDecimalPlaces(0, D.ROUND_UP).toFixed(0),
  );
  const minRemainderIdr = BigInt(
    new D(MIN_TOKEN_REMAINDER_USD.toString())
      .mul(input.rate.toString())
      .toDecimalPlaces(0, D.ROUND_UP)
      .toFixed(0),
  );
  const room = fullPoints - minRemainderIdr;
  if (room <= 0n || input.balance <= 0n) return 0n;
  return input.balance < room ? input.balance : room;
}
