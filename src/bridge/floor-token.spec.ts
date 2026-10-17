import { FloorTokenSigner } from "./floor-token";

describe("FloorTokenSigner", () => {
  const signer = new FloorTokenSigner(Buffer.from("test-secret"));
  const swap = {
    chain: "eip155:5042",
    wallet: "0xAbC0000000000000000000000000000000000001",
    fromAsset: "eip155:5042/erc20:0x3600000000000000000000000000000000000000",
    toAsset: "eip155:5042/erc20:0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    amountRaw: "1000000",
  };
  const now = Date.UTC(2026, 9, 17);

  it("round-trips the floor for the same swap", () => {
    const token = signer.sign(swap, 886384n, now);
    expect(signer.verify(token, swap, now + 60_000)).toBe(886384n);
  });

  it("folds EVM case, like the addresses it binds", () => {
    const token = signer.sign(swap, 886384n, now);
    expect(
      signer.verify(token, { ...swap, wallet: swap.wallet.toLowerCase() }, now),
    ).toBe(886384n);
  });

  it("rejects another swap, an expired token and a tampered floor", () => {
    const token = signer.sign(swap, 886384n, now);
    expect(
      signer.verify(token, { ...swap, amountRaw: "1000001" }, now),
    ).toBeNull();
    expect(signer.verify(token, swap, now + 16 * 60_000)).toBeNull();

    const [v, body, mac] = token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const raised = Buffer.from(
      JSON.stringify({ ...claims, m: "999999" }),
    ).toString("base64url");
    expect(signer.verify(`${v}.${raised}.${mac}`, swap, now)).toBeNull();
    expect(signer.verify("garbage", swap, now)).toBeNull();
  });

  it("rejects a token signed under a different secret", () => {
    const other = new FloorTokenSigner(Buffer.from("rotated"));
    expect(signer.verify(other.sign(swap, 1n, now), swap, now)).toBeNull();
  });

  it("derives a key from JWT_SECRET when no dedicated secret is set", () => {
    const env: Record<string, string> = { JWT_SECRET: "jwt" };
    const derived = FloorTokenSigner.fromConfig((k) => env[k]);
    expect(derived).not.toBeNull();
    // Not the JWT secret itself: a token from one never verifies as the other.
    expect(signer.verify(derived!.sign(swap, 1n, now), swap, now)).toBeNull();
    expect(FloorTokenSigner.fromConfig(() => undefined)).toBeNull();
  });
});
