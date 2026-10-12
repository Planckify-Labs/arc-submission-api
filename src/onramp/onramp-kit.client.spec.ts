const createSession = jest.fn();
jest.mock("@circle-fin/app-kit/server", () => ({
  ...jest.requireActual("@circle-fin/app-kit/server"),
  createAppServerKit: () => ({ onramp: { createSession } }),
}));

import {
  OnrampKitClient,
  OnrampMintError,
  sessionIdOf,
} from "./onramp-kit.client";
import { resolveOnrampConfig } from "./onramp.config";

/** An unsigned JWT-shaped token carrying `claims`. */
function tokenWith(claims: Record<string, unknown>): string {
  const part = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256" })}.${part(claims)}.sig`;
}

const CONFIG = resolveOnrampConfig(
  (k) => ({ ONRAMP_API_KEY: "TEST_API_KEY:id:secret" })[k],
);
const INPUT = {
  appUserId: "user-1",
  destinationAddress: "0x1111111111111111111111111111111111111111",
  assets: { pairs: [{ token: "USDC", chain: "arc" }] },
};

describe("sessionIdOf", () => {
  it("prefers a top-level sessionId", () => {
    expect(
      sessionIdOf({
        sessionId: "top",
        sessionToken: tokenWith({ sessionId: "claim" }),
      }),
    ).toBe("top");
  });

  it("reads the token's sessionId claim when the API omits the field", () => {
    expect(
      sessionIdOf({ sessionToken: tokenWith({ sessionId: "claim" }) }),
    ).toBe("claim");
  });

  it("returns null when neither carries an id", () => {
    expect(sessionIdOf({ sessionToken: tokenWith({ sub: "x" }) })).toBeNull();
    expect(sessionIdOf({ sessionToken: "not-a-jwt" })).toBeNull();
    expect(sessionIdOf({ sessionToken: "a.%%%.c" })).toBeNull();
    expect(sessionIdOf({})).toBeNull();
  });
});

describe("OnrampKitClient.mintSession", () => {
  beforeEach(() => createSession.mockReset());

  it("mints from the sandbox's response shape (no top-level sessionId)", async () => {
    const sessionToken = tokenWith({ sessionId: "sess-123", exp: 1 });
    createSession.mockResolvedValue({
      destinationWallet: INPUT.destinationAddress,
      traceId: "trace-1",
      sessionToken,
      expiresAt: "2026-10-10T12:00:00.000Z",
      widgetUrl: `https://onramp-sandbox.arc.io/?sessionToken=${sessionToken}`,
    });

    await expect(
      new OnrampKitClient().mintSession(CONFIG, INPUT),
    ).resolves.toEqual({
      sessionId: "sess-123",
      sessionToken,
      widgetUrl: `https://onramp-sandbox.arc.io/?sessionToken=${sessionToken}`,
      expiresAt: "2026-10-10T12:00:00.000Z",
      traceId: "trace-1",
    });
  });

  it("still refuses a session with no id anywhere", async () => {
    createSession.mockResolvedValue({
      traceId: "trace-1",
      sessionToken: tokenWith({}),
      expiresAt: "2026-10-10T12:00:00.000Z",
      widgetUrl: "https://onramp-sandbox.arc.io/?sessionToken=x",
    });

    const err = await new OnrampKitClient()
      .mintSession(CONFIG, INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnrampMintError);
    expect((err as OnrampMintError).kind).toBe("upstream");
  });
});
