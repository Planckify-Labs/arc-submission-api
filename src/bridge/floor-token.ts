/**
 * The approved swap floor, carried by the device instead of looked up.
 *
 * The card quote (`purpose: "quote"`) returns a `floorToken`: the floor it
 * reported, bound to the chain, wallet, pair and amount, HMAC-signed and
 * short-lived. The device sends it back on the signing re-quote
 * (`purpose: "execute"`), and the server holds THAT floor. It replaces the
 * Valkey lookup in held-floor.ts, which guesses the approved quote from
 * wallet, pair and amount, and stays only for 5.25.x devices.
 *
 * Opaque to the device and to the model: neither reads it, and a token for
 * any other swap, or past its expiry, is ignored rather than refused (the
 * device's own floor check still runs on the result).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Same window the Valkey fallback holds a floor for. */
const FLOOR_TOKEN_TTL_SECONDS = 15 * 60;

const VERSION = "v1";

/** The swap a floor belongs to. */
export interface FloorBinding {
  chain: string;
  wallet: string;
  fromAsset: string;
  toAsset: string;
  amountRaw: string;
}

interface FloorClaims {
  /** Hash of the binding, so the token carries no address in the clear. */
  b: string;
  /** The floor, raw units of the destination token. */
  m: string;
  /** Expiry, unix seconds. */
  e: number;
}

export class FloorTokenSigner {
  constructor(private readonly secret: Buffer) {}

  /**
   * A dedicated `SWAP_FLOOR_TOKEN_SECRET`, else a key derived from
   * `JWT_SECRET` under its own label so the two never sign for each other.
   * `null` when neither is set: no tokens are issued and every signing
   * re-quote falls back to the device's `minReceiveRaw`.
   */
  static fromConfig(
    get: (key: string) => string | undefined,
  ): FloorTokenSigner | null {
    const dedicated = get("SWAP_FLOOR_TOKEN_SECRET");
    if (dedicated) return new FloorTokenSigner(Buffer.from(dedicated));
    const jwt = get("JWT_SECRET");
    if (!jwt) return null;
    return new FloorTokenSigner(
      createHmac("sha256", jwt).update("takumi:swap-floor-token").digest(),
    );
  }

  sign(binding: FloorBinding, floor: bigint, now = Date.now()): string {
    const claims: FloorClaims = {
      b: bindingHash(binding),
      m: floor.toString(),
      e: Math.floor(now / 1000) + FLOOR_TOKEN_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${VERSION}.${body}.${this.mac(body)}`;
  }

  /** The floor in `token`, or `null` if it is not a live token for `binding`. */
  verify(
    token: string,
    binding: FloorBinding,
    now = Date.now(),
  ): bigint | null {
    const [version, body, mac, extra] = token.split(".");
    if (version !== VERSION || !body || !mac || extra !== undefined)
      return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    let claims: Partial<FloorClaims>;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof claims.e !== "number" || claims.e * 1000 <= now) return null;
    if (claims.b !== bindingHash(binding)) return null;
    if (typeof claims.m !== "string" || !/^[0-9]+$/.test(claims.m)) return null;
    return BigInt(claims.m);
  }

  private mac(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

function bindingHash(b: FloorBinding): string {
  // EVM hex folds case; other namespaces (base58) are case-sensitive.
  const fold = b.chain.startsWith("eip155:")
    ? (v: string) => v.toLowerCase()
    : (v: string) => v;
  return createHash("sha256")
    .update(
      [
        b.chain,
        fold(b.wallet),
        fold(b.fromAsset),
        fold(b.toAsset),
        b.amountRaw,
      ].join("|"),
    )
    .digest("base64url");
}
