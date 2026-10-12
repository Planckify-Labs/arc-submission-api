jest.mock("expo-server-sdk", () => ({ Expo: class {} }));

import { HttpException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { type OnrampKitClient, OnrampMintError } from "./onramp-kit.client";
import { normalizeOnrampWebhook } from "./onramp-webhook";
import { isBareHostname, resolveOnrampConfig } from "./onramp.config";
import { OnrampService } from "./onramp.service";

const OWNER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const ARC = "eip155:5042002";

const ENV: Record<string, string> = {
  ONRAMP_ENABLED: "true",
  ONRAMP_API_KEY: "TEST_API_KEY:id:secret",
  ONRAMP_REFERRER_DOMAIN: "onramp.takumipay.xyz",
  ONRAMP_HOSTED_PAGE_URL: "https://onramp.takumipay.xyz/v1/",
};

const SESSION = {
  sessionId: "sess_1",
  sessionToken: "tok",
  widgetUrl: "https://onramp-sandbox.arc.io/?t=tok",
  expiresAt: "2026-10-08T12:30:00Z",
  traceId: "trace",
};

function build(env: Record<string, string> = ENV) {
  const kit = { mintSession: jest.fn().mockResolvedValue(SESSION) };
  const prisma = {
    onrampOrder: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  const rateLimit = {
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
  };
  const counters = new Map<string, number>();
  const valkey = {
    incr: jest.fn(async (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    }),
    expire: jest.fn().mockResolvedValue(true),
  };
  const push = { sendToWallet: jest.fn().mockResolvedValue({ attempted: 1 }) };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const service = new OnrampService(
    config,
    kit as unknown as OnrampKitClient,
    prisma as never,
    rateLimit as never,
    valkey as never,
    push as never,
  );
  return { service, kit, prisma, rateLimit, valkey, push };
}

const user = {
  id: "u1",
  walletAddress: OWNER,
  addressNamespace: "eip155" as const,
};

describe("resolveOnrampConfig", () => {
  it("defaults to sandbox on Arc Testnet", () => {
    const c = resolveOnrampConfig((k) => ENV[k]);
    expect(c.environment).toBe("sandbox");
    expect(c.enabled).toBe(true);
    expect(c.widgetBaseUrl).toBe("https://onramp-sandbox.arc.io");
    expect(c.support.map((s) => s.chainKey)).toEqual([ARC]);
  });

  it("keeps production dark until a chain is named", () => {
    const c = resolveOnrampConfig(
      (k) => ({ ...ENV, ONRAMP_ENVIRONMENT: "production" })[k],
    );
    expect(c.widgetBaseUrl).toBe("https://onramp.arc.io");
    expect(c.enabled).toBe(false);
  });

  it("is on by default, needing only a key and the hosted page", () => {
    const c = resolveOnrampConfig(
      (k) =>
        (
          ({
            ONRAMP_API_KEY: "TEST_API_KEY:id:secret",
            ONRAMP_HOSTED_PAGE_URL: "https://onramp.takumipay.xyz/v1/",
          }) as Record<string, string>
        )[k],
    );
    expect(c.enabled).toBe(true);
    expect(resolveOnrampConfig(() => undefined).disabledReason).toBe(
      "no_api_key",
    );
  });

  it("says why it is disabled", () => {
    const reason = (env: Record<string, string>) =>
      resolveOnrampConfig((k) => ({ ...ENV, ...env })[k]).disabledReason;
    expect(reason({})).toBeNull();
    expect(reason({ ONRAMP_ENABLED: "false" })).toBe("flag_off");
    expect(reason({ ONRAMP_API_KEY: "" })).toBe("no_api_key");
    expect(reason({ ONRAMP_HOSTED_PAGE_URL: "" })).toBe("no_hosted_page");
    expect(reason({ ONRAMP_ENVIRONMENT: "production" })).toBe(
      "no_supported_chain",
    );
    expect(
      reason({
        ONRAMP_ENVIRONMENT: "production",
        ONRAMP_REFERRER_DOMAIN: "",
        ONRAMP_SUPPORT:
          '[{"chainKey":"eip155:5042","widgetChain":"arc","tokens":["USDC"]}]',
      }),
    ).toBe("no_referrer_domain");
  });

  it("is disabled without an API key or the flag", () => {
    expect(
      resolveOnrampConfig((k) => ({ ...ENV, ONRAMP_API_KEY: "" })[k]).enabled,
    ).toBe(false);
    expect(
      resolveOnrampConfig((k) => ({ ...ENV, ONRAMP_ENABLED: "false" })[k])
        .enabled,
    ).toBe(false);
  });

  it("rejects a referrer domain that is not a bare hostname", () => {
    for (const bad of [
      "https://onramp.takumipay.xyz",
      "onramp.takumipay.xyz:443",
      "onramp.takumipay.xyz/buy",
      "*.takumipay.xyz",
    ]) {
      expect(() =>
        resolveOnrampConfig(
          (k) => ({ ...ENV, ONRAMP_REFERRER_DOMAIN: bad })[k],
        ),
      ).toThrow();
    }
    expect(isBareHostname("10.0.0.1")).toBe(false);
  });

  it("rejects a non-https hosted page", () => {
    expect(() =>
      resolveOnrampConfig(
        (k) => ({ ...ENV, ONRAMP_HOSTED_PAGE_URL: "http://x.example" })[k],
      ),
    ).toThrow();
  });

  it("allows a localhost page in sandbox only, keeping its trailing slash", () => {
    const local = "http://localhost:5180/v1/";
    expect(
      resolveOnrampConfig((k) => ({ ...ENV, ONRAMP_HOSTED_PAGE_URL: local })[k])
        .hostedPageUrl,
    ).toBe(local);
    expect(() =>
      resolveOnrampConfig(
        (k) =>
          ({
            ...ENV,
            ONRAMP_ENVIRONMENT: "production",
            ONRAMP_HOSTED_PAGE_URL: local,
          })[k],
      ),
    ).toThrow();
    // The LAN address is what the widget refuses as a frame parent.
    expect(() =>
      resolveOnrampConfig(
        (k) =>
          ({ ...ENV, ONRAMP_HOSTED_PAGE_URL: "http://192.168.1.173:5180/v1/" })[
            k
          ],
      ),
    ).toThrow();
  });
});

describe("OnrampService.getConfigView", () => {
  it("still lists the chains without a key, so a debug build can preview", () => {
    const { service } = build({ ONRAMP_API_KEY: "" });
    const view = service.getConfigView();
    expect(view.enabled).toBe(false);
    expect(view.disabledReason).toBe("no_api_key");
    expect(view.support.map((s) => s.chainKey)).toEqual([ARC]);
  });

  it("lists nothing when switched off", () => {
    const { service } = build({ ...ENV, ONRAMP_ENABLED: "false" });
    expect(service.getConfigView().support).toEqual([]);
  });
});

describe("OnrampService.createSession", () => {
  it("mints for the caller's own wallet with server-built assets", async () => {
    const { service, kit, prisma } = build();
    const s = await service.createSession(user, {
      destinationAddress: OWNER.toUpperCase().replace("0X", "0x"),
      chainKey: ARC,
    });
    expect(s.sessionId).toBe("sess_1");
    const input = kit.mintSession.mock.calls[0][1];
    expect(input.appUserId).toBe("u1");
    expect(input.assets).toEqual({
      pairs: [
        { token: "USDC", chain: "arc" },
        { token: "EURC", chain: "arc" },
      ],
    });
    expect(prisma.onrampOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", sessionId: "sess_1" }),
    });
  });

  it("refuses to mint for someone else's address", async () => {
    const { service, kit } = build();
    await expect(
      service.createSession(user, {
        destinationAddress: STRANGER,
        chainKey: ARC,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(kit.mintSession).not.toHaveBeenCalled();
  });

  it("refuses a JWT from another namespace", async () => {
    const { service } = build();
    await expect(
      service.createSession(
        { ...user, addressNamespace: "solana" },
        { destinationAddress: OWNER, chainKey: ARC },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an unsupported chain", async () => {
    const { service } = build();
    await expect(
      service.createSession(user, {
        destinationAddress: OWNER,
        chainKey: "eip155:1",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 503 when disabled", async () => {
    const { service } = build({ ...ENV, ONRAMP_ENABLED: "false" });
    await expect(
      service.createSession(user, { destinationAddress: OWNER, chainKey: ARC }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("returns 429 when the per-user limit is hit", async () => {
    const { service, rateLimit } = build();
    rateLimit.checkRateLimit.mockResolvedValue({ allowed: false });
    await expect(
      service.createSession(user, { destinationAddress: OWNER, chainKey: ARC }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it.each([
    ["input", 400],
    ["rate_limit", 429],
    ["network", 504],
    ["upstream", 502],
    ["unknown", 500],
  ] as const)(
    "maps a %s kit failure to %i with a fixed label",
    async (kind, status) => {
      const { service, kit } = build();
      kit.mintSession.mockRejectedValue(new OnrampMintError(kind, 1));
      const err = await service
        .createSession(user, { destinationAddress: OWNER, chainKey: ARC })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(status);
      expect(err.getResponse()).toEqual({
        message: "Could not start onramp",
        code: "ONRAMP_MINT_FAILED",
      });
    },
  );

  it("still returns the session when the ledger write fails", async () => {
    const { service, prisma } = build();
    prisma.onrampOrder.create.mockRejectedValue(new Error("db down"));
    await expect(
      service.createSession(user, { destinationAddress: OWNER, chainKey: ARC }),
    ).resolves.toMatchObject({ sessionId: "sess_1" });
  });
});

describe("onramp webhook", () => {
  const settled = {
    notificationId: "n1",
    event: "DEPOSIT_SETTLED",
    code: "DEPOSIT_SETTLED",
    payload: {
      sessionId: "sess_1",
      orderId: "ord_1",
      amount: 25,
      tokenSymbol: "usdc",
      transactionHash: `0x${"a".repeat(64)}`,
    },
  };

  it("normalizes only the documented vocabulary", () => {
    expect(normalizeOnrampWebhook(settled)).toMatchObject({
      transition: "settled",
      sessionId: "sess_1",
      amount: "25",
      token: "USDC",
    });
    expect(normalizeOnrampWebhook({ event: "SOMETHING_NEW" })).toBeNull();
    expect(normalizeOnrampWebhook({ event: "DEPOSIT_SETTLED" })).toBeNull();
    expect(
      normalizeOnrampWebhook({
        event: "DEPOSIT_NOT_COMPLETED",
        code: "weird",
        payload: { orderId: "o" },
      })?.failureCode,
    ).toBe("UNKNOWN");
  });

  it("settles once, pushes once, and drops a duplicate delivery", async () => {
    const { service, prisma, push } = build();
    prisma.onrampOrder.findFirst.mockResolvedValue({
      id: "o1",
      status: "PENDING",
      orderId: null,
      txHash: null,
      amount: null,
      token: null,
    });
    prisma.onrampOrder.update.mockImplementation(async ({ data }) => ({
      id: "o1",
      walletAddress: OWNER,
      ...data,
    }));
    const update = normalizeOnrampWebhook(settled);
    if (!update) throw new Error("expected an update");

    await service.applyUpdate(update);
    await service.applyUpdate(update);

    expect(prisma.onrampOrder.update).toHaveBeenCalledTimes(1);
    expect(prisma.onrampOrder.update.mock.calls[0][0].data.status).toBe(
      "SETTLED",
    );
    expect(push.sendToWallet).toHaveBeenCalledTimes(1);
    expect(push.sendToWallet.mock.calls[0][0].body).not.toMatch(
      /Circle|Arc|Transak/,
    );
  });

  it("never moves a terminal order", async () => {
    const { service, prisma } = build();
    prisma.onrampOrder.findFirst.mockResolvedValue({
      id: "o1",
      status: "SETTLED",
    });
    const update = normalizeOnrampWebhook({ ...settled, notificationId: "n2" });
    if (!update) throw new Error("expected an update");
    await service.applyUpdate(update);
    expect(prisma.onrampOrder.update).not.toHaveBeenCalled();
  });
});
