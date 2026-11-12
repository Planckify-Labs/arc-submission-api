import type { ConfigService } from "@nestjs/config";
import type { Job, Queue } from "bullmq";
import type { PrismaService } from "../prisma/prisma.service";
import { NotificationPreferencesService } from "./notification-preferences.service";
import {
  type PushDispatchJobData,
  type PushReceiptEntry,
  PushDeliveryStatus,
  PushService,
  formatFiatMinor,
  formatTokenMicros,
} from "./push.service";

// Per-test control over what the fake Expo relay answers with.
const expoBehaviour: {
  send: (chunk: { to: string }[]) => Promise<unknown[]>;
  receipts: (ids: string[]) => Promise<Record<string, unknown>>;
} = {
  send: async (chunk) =>
    chunk.map((_, i) => ({ status: "ok", id: `ticket-${i}` })),
  receipts: async (ids) =>
    Object.fromEntries(ids.map((id) => [id, { status: "ok" }])),
};

jest.mock("expo-server-sdk", () => {
  class FakeExpo {
    static isExpoPushToken(token: string) {
      return token.startsWith("ExponentPushToken[");
    }
    chunkPushNotifications(messages: unknown[]) {
      return [messages];
    }
    async sendPushNotificationsAsync(chunk: { to: string }[]) {
      return expoBehaviour.send(chunk);
    }
    chunkPushNotificationReceiptIds(ids: string[]) {
      return [ids];
    }
    async getPushNotificationReceiptsAsync(ids: string[]) {
      return expoBehaviour.receipts(ids);
    }
  }
  return { Expo: FakeExpo };
});

type Device = { id: string; token: string };
type LogRow = Record<string, unknown> & {
  id: string;
  deliveryStatus: string;
  pendingDeviceIds: string[];
  expoTicketIds: string[];
  attempts: number;
};

/**
 * In-memory stand-in for the slice of Prisma the service touches. Rows in
 * `logs` behave like the real NotificationLog table (create / update /
 * updateMany with a status filter), which is what the outbox lifecycle
 * tests need; device lookups answer from the fixtures.
 */
function buildHarness(
  opts: {
    directDevices?: Device[];
    user?: { id?: string; walletAddress: string | null } | null;
    walletOwner?: { id: string } | null;
    walletSubs?: { deviceToken: Device }[];
    /** Devices the worker finds by id (defaults to every fixture device). */
    liveDevices?: Device[];
    intent?: Record<string, unknown> | null;
    activityRow?: { id: string } | null;
    logs?: LogRow[];
    /** `devicePushToken.findUnique` result — a token seen before. */
    seenDevice?: { id: string } | null;
    /** `notificationPreference.findUnique` result for the target user. */
    preference?: { categories: Record<string, boolean> } | null;
  } = {},
) {
  const logs: LogRow[] = opts.logs ?? [];
  let nextId = 1;

  const allDevices = [
    ...(opts.directDevices ?? []),
    ...(opts.walletSubs ?? []).map((s) => s.deviceToken),
  ];
  const liveDevices = opts.liveDevices ?? allDevices;

  const matches = (row: LogRow, where: Record<string, unknown>) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    const status = where.deliveryStatus as
      | string
      | { in?: string[]; not?: string }
      | undefined;
    if (typeof status === "string" && row.deliveryStatus !== status)
      return false;
    if (status && typeof status === "object") {
      if (status.in && !status.in.includes(row.deliveryStatus)) return false;
      if (status.not && row.deliveryStatus === status.not) return false;
    }
    return true;
  };
  const isOp = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
  const apply = (row: LogRow, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (isOp(v) && typeof v.increment === "number") {
        row[k] = ((row[k] as number) ?? 0) + v.increment;
      } else if (isOp(v) && Array.isArray(v.push)) {
        row[k] = [...((row[k] as string[]) ?? []), ...(v.push as string[])];
      } else {
        row[k] = v;
      }
    }
  };

  const notificationLog = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: LogRow = {
        id: `log_${nextId++}`,
        deliveryStatus: PushDeliveryStatus.queued,
        attempts: 0,
        expoTicketIds: [],
        pendingDeviceIds: [],
        lastError: null,
        dispatchedAt: null,
        expiresAt: null,
        channelId: null,
        imageUrl: null,
        sentAt: new Date(),
        ...data,
      };
      logs.push(row);
      return { id: row.id };
    }),
    createMany: jest.fn(
      async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0;
        for (const item of data) {
          if (
            item.dedupeKey &&
            logs.some((r) => r.dedupeKey === item.dedupeKey)
          ) {
            continue; // ON CONFLICT DO NOTHING
          }
          logs.push({
            id: String(item.id),
            deliveryStatus: PushDeliveryStatus.queued,
            attempts: 0,
            expoTicketIds: [],
            pendingDeviceIds: [],
            lastError: null,
            dispatchedAt: null,
            expiresAt: null,
            channelId: null,
            imageUrl: null,
            sentAt: new Date(),
            ...item,
          });
          count += 1;
        }
        return { count };
      },
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        logs.find((r) => r.id === where.id) ?? null,
    ),
    findMany: jest.fn(async () => logs.filter((r) => r.__stuck === true)),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = logs.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        apply(row, data);
        return row;
      },
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of logs) {
          if (!matches(row, where)) continue;
          apply(row, data);
          count += 1;
        }
        return { count };
      },
    ),
  };

  const devicePushToken = {
    findMany: jest.fn(
      async ({
        where,
      }: {
        where: {
          userId?: string | { in: string[] };
          id?: { in: string[] };
          token?: { in: string[] };
        };
      }) => {
        if (where.id)
          return liveDevices.filter((d) => where.id!.in.includes(d.id));
        if (where.token)
          return allDevices.filter((d) => where.token!.in.includes(d.token));
        if (typeof where.userId === "string") {
          return where.userId === (opts.walletOwner?.id ?? "__owner__")
            ? (opts.directDevices ?? [])
            : (opts.directDevices ?? []);
        }
        return [];
      },
    ),
    updateMany: jest.fn(async () => ({ count: 0 })),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    findUnique: jest.fn(async () => opts.seenDevice ?? null),
    upsert: jest.fn(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: "device_upserted",
        ...create,
      }),
    ),
  };

  const notificationPreference = {
    findUnique: jest.fn(async () => opts.preference ?? null),
  };

  const walletPushSubscription = {
    findMany: jest.fn(async () => opts.walletSubs ?? []),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };

  const prisma = {
    devicePushToken,
    walletPushSubscription,
    notificationLog,
    notificationPreference,
    user: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; walletAddress?: string };
        }) => {
          if (where.walletAddress !== undefined)
            return opts.walletOwner ?? null;
          return opts.user ?? null;
        },
      ),
    },
    paymentIntent: {
      findUnique: jest.fn(async () => opts.intent ?? null),
    },
    transactionHistory: {
      findFirst: jest.fn(async () => opts.activityRow ?? null),
    },
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg === "function") return arg(prisma);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };

  const configService = { get: jest.fn(() => undefined) };
  const dispatchQueue = { add: jest.fn(async () => ({})) };
  const receiptQueue = { add: jest.fn(async () => ({})) };

  const service = new PushService(
    prisma as unknown as PrismaService,
    configService as unknown as ConfigService,
    new NotificationPreferencesService(prisma as unknown as PrismaService),
    dispatchQueue as unknown as Queue<PushDispatchJobData>,
    receiptQueue as unknown as Queue<{ entries: PushReceiptEntry[] }>,
  );

  return { service, prisma, dispatchQueue, receiptQueue, logs };
}

function fakeJob(
  notificationLogId: string,
  { attemptsMade = 0, attempts = 8 } = {},
): Job<PushDispatchJobData> {
  return {
    id: notificationLogId,
    data: { notificationLogId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<PushDispatchJobData>;
}

beforeEach(() => {
  expoBehaviour.send = async (chunk) =>
    chunk.map((_, i) => ({ status: "ok", id: `ticket-${i}` }));
  expoBehaviour.receipts = async (ids) =>
    Object.fromEntries(ids.map((id) => [id, { status: "ok" }]));
});

describe("PushService.sendToUser — device resolution", () => {
  it("fans out to every device a wallet is registered on, across multiple physical devices", async () => {
    const { service, prisma, logs, dispatchQueue } = buildHarness({
      directDevices: [
        { id: "device-primary", token: "ExponentPushToken[primary]" },
      ],
      user: { walletAddress: "GABC123" },
      walletSubs: [
        {
          deviceToken: {
            id: "device-tablet",
            token: "ExponentPushToken[tablet]",
          },
        },
        {
          deviceToken: {
            id: "device-secondphone",
            token: "ExponentPushToken[secondphone]",
          },
        },
      ],
    });

    const result = await service.sendToUser({
      userId: "user_1",
      title: "t",
      body: "b",
    });

    expect(result.attempted).toBe(3);
    // Stellar (base32) is case-significant — the lookup must use the address
    // verbatim, NOT a corrupting lowercase fold.
    expect(prisma.walletPushSubscription.findMany).toHaveBeenCalledWith({
      where: { walletAddress: "GABC123" },
      select: { deviceToken: { select: { id: true, token: true } } },
    });
    // Outbox row first, then exactly one dispatch job keyed by it.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.queued,
      recipientCount: 3,
      pendingDeviceIds: [
        "device-primary",
        "device-tablet",
        "device-secondphone",
      ],
    });
    expect(dispatchQueue.add).toHaveBeenCalledWith(
      "dispatch",
      { notificationLogId: "log_1" },
      { jobId: "log_1" },
    );
  });

  it("de-dupes a device found via both the direct userId match and the wallet-subscription fallback", async () => {
    const { service } = buildHarness({
      directDevices: [{ id: "device-a", token: "ExponentPushToken[a]" }],
      user: { walletAddress: "GABC123" },
      walletSubs: [
        { deviceToken: { id: "device-a", token: "ExponentPushToken[a]" } },
      ],
    });

    const result = await service.sendToUser({
      userId: "user_1",
      title: "t",
      body: "b",
    });

    expect(result.attempted).toBe(1);
  });

  it("falls back to wallet-subscription devices when DevicePushToken.userId is stale (bound to a different wallet's user)", async () => {
    const { service } = buildHarness({
      directDevices: [],
      user: { walletAddress: "GSECONDWALLET" },
      walletSubs: [
        { deviceToken: { id: "device-b", token: "ExponentPushToken[b]" } },
      ],
    });

    const result = await service.sendToUser({
      userId: "user_2",
      title: "t",
      body: "b",
    });

    expect(result.attempted).toBe(1);
  });

  it("records a no_device row (and enqueues nothing) when the user has no wallet address and no direct devices", async () => {
    const { service, prisma, logs, dispatchQueue } = buildHarness({
      directDevices: [],
      user: { walletAddress: null },
    });

    const result = await service.sendToUser({
      userId: "user_3",
      title: "t",
      body: "b",
      source: "point_deposit",
    });

    expect(result.attempted).toBe(0);
    expect(prisma.walletPushSubscription.findMany).not.toHaveBeenCalled();
    // The row is the audit trail for "why did nobody get this?".
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.no_device,
      recipientCount: 0,
      source: "point_deposit",
    });
    expect(dispatchQueue.add).not.toHaveBeenCalled();
  });
});

describe("PushService.sendToWallet — device resolution", () => {
  it("reaches a device linked to the wallet's own user even when its subscription row is missing", async () => {
    // The asymmetry users report: transfers FROM the wallet notify (routed
    // by userId) but transfers TO it don't (subscription row lost to a
    // racing registration). The owner-user fallback closes that gap.
    const { service, prisma, logs } = buildHarness({
      walletSubs: [],
      walletOwner: { id: "user_owner" },
      directDevices: [
        { id: "device-owner", token: "ExponentPushToken[owner]" },
      ],
    });

    const result = await service.sendToWallet({
      walletAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      title: "Transfer Received",
      body: "b",
    });

    expect(result.attempted).toBe(1);
    // Looked up in canonical (EIP-55) form on both routes.
    const canonical = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(prisma.walletPushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletAddress: canonical } }),
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { walletAddress: canonical },
      select: { id: true },
    });
    expect(logs[0]).toMatchObject({ walletAddress: canonical });
  });

  it("de-dupes a device present on both the subscription and owner routes, and trims pasted whitespace", async () => {
    const device = { id: "device-x", token: "ExponentPushToken[x]" };
    const { service } = buildHarness({
      walletSubs: [{ deviceToken: device }],
      walletOwner: { id: "user_owner" },
      directDevices: [device],
    });

    const result = await service.sendToWallet({
      walletAddress: "  GABC123 ",
      title: "t",
      body: "b",
    });

    expect(result.attempted).toBe(1);
  });
});

describe("PushService.enqueue", () => {
  it("sends inline when the queue cannot take the job, so the user still gets it now", async () => {
    const { service, dispatchQueue, logs } = buildHarness({
      directDevices: [{ id: "device-a", token: "ExponentPushToken[a]" }],
      user: { walletAddress: null },
    });
    dispatchQueue.add.mockRejectedValueOnce(new Error("redis down"));

    await service.sendToUser({ userId: "user_1", title: "t", body: "b" });

    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.pending,
      attempts: 1,
      expoTicketIds: ["ticket-0"],
    });
  });
});

describe("PushService.attemptDelivery — outbox lifecycle", () => {
  const a = { id: "device-a", token: "ExponentPushToken[a]" };
  const b = { id: "device-b", token: "ExponentPushToken[b]" };

  function stagedLog(overrides: Partial<LogRow> = {}): LogRow {
    return {
      id: "log_1",
      title: "Transfer Received",
      body: "You received 5 USDC",
      data: { type: "transfer" },
      source: "transfer",
      channelId: "transfers",
      imageUrl: null,
      deliveryStatus: PushDeliveryStatus.queued,
      pendingDeviceIds: [a.id, b.id],
      targetDeviceIds: [a.id, b.id],
      expoTicketIds: [],
      attempts: 0,
      lastError: null,
      dispatchedAt: null,
      expiresAt: null,
      sentAt: new Date(),
      ...overrides,
    };
  }

  it("accepted tickets move the row to pending, stamp the devices, and schedule the receipt check", async () => {
    const { service, logs, receiptQueue, prisma } = buildHarness({
      liveDevices: [a, b],
      logs: [stagedLog()],
    });

    const outcome = await service.attemptDelivery("log_1", { final: false });

    expect(outcome).toBe("done");
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.pending,
      pendingDeviceIds: [],
      expoTicketIds: ["ticket-0", "ticket-1"],
      attempts: 1,
    });
    expect(logs[0].dispatchedAt).toBeInstanceOf(Date);
    expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [a.id, b.id] } },
      }),
    );
    expect(receiptQueue.add).toHaveBeenCalledWith(
      "check-receipts",
      {
        entries: [
          expect.objectContaining({
            ticketId: "ticket-0",
            deviceId: a.id,
            notificationLogId: "log_1",
          }),
          expect.objectContaining({
            ticketId: "ticket-1",
            deviceId: b.id,
            notificationLogId: "log_1",
          }),
        ],
      },
      { delay: 20 * 60 * 1000 },
    );
  });

  it("stamps the inbox id and target wallet on the delivered payload, producer keys first", async () => {
    const sent: Array<{ data?: Record<string, unknown> }> = [];
    expoBehaviour.send = async (chunk) => {
      sent.push(...(chunk as Array<{ data?: Record<string, unknown> }>));
      return chunk.map((_, i) => ({ status: "ok", id: `ticket-${i}` }));
    };
    const { service } = buildHarness({
      liveDevices: [a],
      logs: [
        stagedLog({
          pendingDeviceIds: [a.id],
          walletAddress: "0xRecipient",
          data: { type: "transfer", transactionId: "tx_1" },
        }),
      ],
    });

    await service.attemptDelivery("log_1", { final: false });

    expect(sent[0]?.data).toEqual({
      notificationId: "log_1",
      targetWallet: "0xRecipient",
      type: "transfer",
      transactionId: "tx_1",
    });
  });

  it("a user-addressed push names the user's wallet as the target", async () => {
    const sent: Array<{ data?: Record<string, unknown> }> = [];
    expoBehaviour.send = async (chunk) => {
      sent.push(...(chunk as Array<{ data?: Record<string, unknown> }>));
      return chunk.map((_, i) => ({ status: "ok", id: `ticket-${i}` }));
    };
    const { service } = buildHarness({
      liveDevices: [a],
      user: { walletAddress: "GUSERWALLET" },
      logs: [
        stagedLog({
          pendingDeviceIds: [a.id],
          walletAddress: null,
          userId: "user_1",
          data: { type: "point_deposit" },
        }),
      ],
    });

    await service.attemptDelivery("log_1", { final: false });

    expect(sent[0]?.data).toMatchObject({
      notificationId: "log_1",
      targetWallet: "GUSERWALLET",
    });
  });

  it("a transport failure keeps every device pending and asks for a retry — nothing is lost", async () => {
    expoBehaviour.send = async () => {
      throw new Error("ECONNRESET");
    };
    const { service, logs, receiptQueue } = buildHarness({
      liveDevices: [a, b],
      logs: [stagedLog()],
    });

    const outcome = await service.attemptDelivery("log_1", { final: false });

    expect(outcome).toBe("retry");
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.queued,
      pendingDeviceIds: [a.id, b.id],
      expoTicketIds: [],
      lastError: "transport failure",
    });
    expect(receiptQueue.add).not.toHaveBeenCalled();
  });

  it("a retry only re-sends the devices Expo has not accepted yet", async () => {
    // First attempt: device-a accepted, device-b rate-limited.
    expoBehaviour.send = async (chunk) =>
      chunk.map((m, i) =>
        m.to === b.token
          ? {
              status: "error",
              message: "rate",
              details: { error: "MessageRateExceeded" },
            }
          : { status: "ok", id: `ticket-${i}` },
      );
    const { service, logs } = buildHarness({
      liveDevices: [a, b],
      logs: [stagedLog()],
    });

    expect(await service.attemptDelivery("log_1", { final: false })).toBe(
      "retry",
    );
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.queued,
      pendingDeviceIds: [b.id],
      expoTicketIds: ["ticket-0"],
    });

    // Second attempt: only device-b goes out.
    const sent: string[] = [];
    expoBehaviour.send = async (chunk) => {
      sent.push(...chunk.map((m) => m.to));
      return chunk.map((_, i) => ({ status: "ok", id: `retry-${i}` }));
    };
    expect(await service.attemptDelivery("log_1", { final: false })).toBe(
      "done",
    );
    expect(sent).toEqual([b.token]);
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.pending,
      pendingDeviceIds: [],
      expoTicketIds: ["ticket-0", "retry-0"],
      attempts: 2,
    });
  });

  it("DeviceNotRegistered prunes the device instead of retrying it; all pruned → unregistered", async () => {
    expoBehaviour.send = async (chunk) =>
      chunk.map(() => ({
        status: "error",
        message: "gone",
        details: { error: "DeviceNotRegistered" },
      }));
    const { service, logs, prisma } = buildHarness({
      liveDevices: [a, b],
      logs: [stagedLog()],
    });

    const outcome = await service.attemptDelivery("log_1", { final: false });

    expect(outcome).toBe("done");
    expect(prisma.devicePushToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [a.id, b.id] } },
    });
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.unregistered,
      pendingDeviceIds: [],
    });
  });

  it("a permanent per-message rejection is not retried", async () => {
    expoBehaviour.send = async (chunk) =>
      chunk.map(() => ({
        status: "error",
        message: "too big",
        details: { error: "MessageTooBig" },
      }));
    const { service, logs } = buildHarness({
      liveDevices: [a],
      logs: [stagedLog({ pendingDeviceIds: [a.id], targetDeviceIds: [a.id] })],
    });

    expect(await service.attemptDelivery("log_1", { final: false })).toBe(
      "done",
    );
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.undelivered,
      pendingDeviceIds: [],
      lastError: "too big (code=MessageTooBig)",
    });
  });

  it("on the final attempt an unreachable Expo marks the row failed rather than queued forever", async () => {
    expoBehaviour.send = async () => {
      throw new Error("503");
    };
    const { service, logs } = buildHarness({
      liveDevices: [a],
      logs: [stagedLog({ pendingDeviceIds: [a.id] })],
    });

    expect(await service.attemptDelivery("log_1", { final: true })).toBe(
      "done",
    );
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.failed,
      pendingDeviceIds: [a.id],
    });
    expect(logs[0].deliveryCheckedAt).toBeInstanceOf(Date);
  });

  it("does not send a push whose TTL has already passed", async () => {
    const sent: string[] = [];
    expoBehaviour.send = async (chunk) => {
      sent.push(...chunk.map((m) => m.to));
      return chunk.map((_, i) => ({ status: "ok", id: `t-${i}` }));
    };
    const { service, logs } = buildHarness({
      liveDevices: [a],
      logs: [
        stagedLog({
          pendingDeviceIds: [a.id],
          expiresAt: new Date(Date.now() - 1000),
        }),
      ],
    });

    await service.attemptDelivery("log_1", { final: false });

    expect(sent).toEqual([]);
    expect(logs[0].deliveryStatus).toBe(PushDeliveryStatus.expired);
  });

  it("devices pruned since staging simply drop out; nothing left → unregistered", async () => {
    const { service, logs } = buildHarness({
      liveDevices: [],
      logs: [stagedLog()],
    });

    await service.attemptDelivery("log_1", { final: false });

    expect(logs[0].deliveryStatus).toBe(PushDeliveryStatus.unregistered);
  });

  it("only a queued row can be claimed — a concurrent job, sweep or inline send skips without double-sending", async () => {
    const sent: string[] = [];
    expoBehaviour.send = async (chunk) => {
      sent.push(...chunk.map((m) => m.to));
      return chunk.map((_, i) => ({ status: "ok", id: `t-${i}` }));
    };
    const { service, logs } = buildHarness({
      liveDevices: [a],
      logs: [
        stagedLog({
          pendingDeviceIds: [a.id],
          deliveryStatus: PushDeliveryStatus.sending,
        }),
      ],
    });

    expect(await service.attemptDelivery("log_1", { final: false })).toBe(
      "skipped",
    );
    expect(sent).toEqual([]);
    expect(logs[0].attempts).toBe(0);
  });

  it("an unexpected error mid-attempt releases the claim back to queued", async () => {
    const { service, logs, prisma } = buildHarness({
      liveDevices: [a],
      logs: [stagedLog({ pendingDeviceIds: [a.id] })],
    });
    prisma.devicePushToken.findMany.mockRejectedValueOnce(
      new Error("db hiccup"),
    );

    await expect(
      service.attemptDelivery("log_1", { final: false }),
    ).rejects.toThrow("db hiccup");
    expect(logs[0]).toMatchObject({
      deliveryStatus: PushDeliveryStatus.queued,
      lastError: "db hiccup",
    });
  });

  it("processDispatch throws when devices remain so BullMQ schedules the backoff retry", async () => {
    expoBehaviour.send = async () => {
      throw new Error("ECONNRESET");
    };
    const { service } = buildHarness({
      liveDevices: [a],
      logs: [stagedLog({ pendingDeviceIds: [a.id] })],
    });

    await expect(
      service.processDispatch(fakeJob("log_1", { attemptsMade: 0 })),
    ).rejects.toThrow(/still pending/);
  });

  it("processDispatch treats the last attempt of the budget as final", async () => {
    expoBehaviour.send = async () => {
      throw new Error("ECONNRESET");
    };
    const { service, logs } = buildHarness({
      liveDevices: [a],
      logs: [stagedLog({ pendingDeviceIds: [a.id] })],
    });

    await expect(
      service.processDispatch(
        fakeJob("log_1", { attemptsMade: 7, attempts: 8 }),
      ),
    ).resolves.toBeUndefined();
    expect(logs[0].deliveryStatus).toBe(PushDeliveryStatus.failed);
  });
});

describe("PushService.sweepOutbox", () => {
  it("re-enqueues stuck rows under a fresh job id and releases stale `sending` claims", async () => {
    const { service, logs, dispatchQueue } = buildHarness({
      logs: [
        {
          id: "log_never_picked_up",
          deliveryStatus: PushDeliveryStatus.queued,
          attempts: 0,
          pendingDeviceIds: ["d"],
          expoTicketIds: [],
          __stuck: true,
        },
        {
          id: "log_worker_died",
          deliveryStatus: PushDeliveryStatus.sending,
          attempts: 2,
          pendingDeviceIds: ["d"],
          expoTicketIds: [],
          __stuck: true,
        },
      ],
    });

    const requeued = await service.sweepOutbox();

    expect(requeued).toBe(2);
    expect(logs[1].deliveryStatus).toBe(PushDeliveryStatus.queued);
    const jobIds = dispatchQueue.add.mock.calls.map(
      (c) => (c as unknown[])[2] as { jobId: string },
    );
    expect(jobIds[0].jobId).toMatch(/^log_never_picked_up:sweep:0:\d+$/);
    expect(jobIds[1].jobId).toMatch(/^log_worker_died:sweep:2:\d+$/);
  });
});

describe("PushService.checkReceipts", () => {
  const entry = (ticketId: string, logId: string): PushReceiptEntry => ({
    ticketId,
    deviceId: "device-a",
    token: "ExponentPushToken[a]",
    notificationLogId: logId,
  });

  it("settles a pending row to delivered", async () => {
    const { service, logs } = buildHarness({
      logs: [
        {
          id: "log_1",
          deliveryStatus: PushDeliveryStatus.pending,
          pendingDeviceIds: [],
          expoTicketIds: ["t1"],
          attempts: 1,
        },
      ],
    });

    await service.checkReceipts([entry("t1", "log_1")]);

    expect(logs[0].deliveryStatus).toBe(PushDeliveryStatus.delivered);
  });

  it("never downgrades a row already proven delivered, and leaves a still-retrying row alone", async () => {
    expoBehaviour.receipts = async (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            status: "error",
            message: "x",
            details: { error: "MismatchSenderId" },
          },
        ]),
      );
    const { service, logs } = buildHarness({
      logs: [
        {
          id: "log_delivered",
          deliveryStatus: PushDeliveryStatus.delivered,
          pendingDeviceIds: [],
          expoTicketIds: ["t1"],
          attempts: 1,
        },
        {
          id: "log_retrying",
          deliveryStatus: PushDeliveryStatus.queued,
          pendingDeviceIds: ["device-b"],
          expoTicketIds: ["t2"],
          attempts: 1,
        },
      ],
    });

    await service.checkReceipts([
      entry("t1", "log_delivered"),
      entry("t2", "log_retrying"),
    ]);

    expect(logs[0].deliveryStatus).toBe(PushDeliveryStatus.delivered);
    expect(logs[1].deliveryStatus).toBe(PushDeliveryStatus.queued);
  });
});

describe("PushService.registerToken", () => {
  it("reconciles subscriptions: keeps listed + just-created rows, drops only stale unlisted ones, tolerates duplicate inserts", async () => {
    const { service, prisma } = buildHarness();

    await service.registerToken({
      userId: "user_1",
      token: "ExponentPushToken[abc]",
      platform: "android",
      wallets: [
        " 0xd8da6bf26964af9d7eed9e03e53415d37aa96045 ",
        "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045", // same wallet, other casing
        "GABC123",
      ],
    });

    const canonical = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const del = prisma.walletPushSubscription.deleteMany.mock.calls[0][0] as {
      where: {
        deviceTokenId: string;
        walletAddress: { notIn: string[] };
        createdAt: { lt: Date };
      };
    };
    expect(del.where.deviceTokenId).toBe("device_upserted");
    expect(del.where.walletAddress.notIn).toEqual([canonical, "GABC123"]);
    // Rows a racing registration created in the last minute survive.
    expect(
      Date.now() - del.where.createdAt.lt.getTime(),
    ).toBeGreaterThanOrEqual(59_000);
    expect(prisma.walletPushSubscription.createMany).toHaveBeenCalledWith({
      data: [
        { deviceTokenId: "device_upserted", walletAddress: canonical },
        { deviceTokenId: "device_upserted", walletAddress: "GABC123" },
      ],
      skipDuplicates: true,
    });
  });

  it("rejects a non-Expo token without touching the database", async () => {
    const { service, prisma } = buildHarness();

    await service.registerToken({
      userId: null,
      token: "not-a-token-at-all",
      platform: "ios",
      wallets: ["GABC123"],
    });

    expect(prisma.devicePushToken.upsert).not.toHaveBeenCalled();
  });
});

describe("payment pushes — one per payment, amount first, money language", () => {
  const device = { id: "dev_1", token: "ExponentPushToken[abc]" };
  const monadIntent = {
    payerUserId: "user_1",
    fiatAmountMinor: 48_888,
    fiatCurrency: "IDR",
    nanopayUsdcAmountMicros: 2_966_861n,
    path: "takumipay",
    merchant: { displayName: "GTron, SELONG" },
    sourceToken: { symbol: "AUSD" },
  };

  it("settled push is a spend note: 'You spent Rp 48.888' / 'at GTron, SELONG · 2.97 AUSD from your balance', landing on the Activity row", async () => {
    const { service, logs } = buildHarness({
      directDevices: [device],
      user: { walletAddress: "0xabc" },
      intent: monadIntent,
      activityRow: { id: "th_1" },
    });
    const spy = jest.spyOn(service, "sendToUser");

    await service.sendSettledPush("pi_1");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        title: "You spent Rp 48.888",
        body: "at GTron, SELONG · 2.97 AUSD from your balance",
        data: expect.objectContaining({
          intentId: "pi_1",
          transactionId: "th_1",
        }),
      }),
    );
    expect(logs).toHaveLength(1);
    const sent = spy.mock.calls[0][0];
    for (const word of [
      "on-chain",
      "settled",
      "verified",
      "network",
      "chain",
    ]) {
      expect(`${sent.title} ${sent.body}`.toLowerCase()).not.toContain(word);
    }
  });

  it("settled push without a named token still leads with the fiat amount", async () => {
    const { service } = buildHarness({
      directDevices: [device],
      user: { walletAddress: "0xabc" },
      intent: { ...monadIntent, sourceToken: null },
    });
    const spy = jest.spyOn(service, "sendToUser");

    await service.sendSettledPush("pi_1");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "You spent Rp 48.888",
        body: "at GTron, SELONG",
      }),
    );
  });

  it("paid-out push is skipped on the on-chain rail (the payer already got 'Paid') but still sent for nanopay", async () => {
    const onchain = buildHarness({
      directDevices: [device],
      user: { walletAddress: "0xabc" },
      intent: monadIntent,
    });
    const spyA = jest.spyOn(onchain.service, "sendToUser");
    await onchain.service.sendPaidOutPush("pi_1");
    expect(spyA).not.toHaveBeenCalled();

    const nanopay = buildHarness({
      directDevices: [device],
      user: { walletAddress: "0xabc" },
      intent: { ...monadIntent, path: "nanopay", sourceToken: null },
    });
    const spyB = jest.spyOn(nanopay.service, "sendToUser");
    await nanopay.service.sendPaidOutPush("pi_1");
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("formats IDR the way the app does and token micros without chain precision noise", () => {
    expect(formatFiatMinor(48_888, "IDR")).toBe("Rp 48.888");
    expect(formatFiatMinor(1_250_000, "IDR")).toBe("Rp 1.250.000");
    expect(formatFiatMinor(1050, "PHP")).toBe("PHP 10.50");
    expect(formatTokenMicros(2_966_861n)).toBe("2.97");
    expect(formatTokenMicros(941_294n)).toBe("0.9413");
  });
});

describe("notification centre — categories, mute, dedupe", () => {
  const device = { id: "dev_1", token: "ExponentPushToken[abc]" };

  it("a muted category is recorded (status muted, zero devices) and never enqueued", async () => {
    const { service, prisma, dispatchQueue } = buildHarness({
      directDevices: [device],
      user: { id: "user_1", walletAddress: null },
      preference: { categories: { defi: false } },
    });
    const result = await service.sendToUser({
      userId: "user_1",
      title: "Time to add to your plan",
      body: "…",
      channelId: "strategies", // → category "defi" via the channel map
    });
    expect(result).toEqual({
      attempted: 0,
      notificationLogId: "log_1",
      muted: true,
    });
    const row = (
      prisma.notificationLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(row.category).toBe("defi");
    expect(row.deliveryStatus).toBe(PushDeliveryStatus.muted);
    expect(row.targetDeviceIds).toEqual([]);
    expect(dispatchQueue.add).not.toHaveBeenCalled();
  });

  it("the digest is off unless explicitly enabled; everything else is on by default", async () => {
    const { service, dispatchQueue } = buildHarness({
      directDevices: [device],
      user: { id: "user_1", walletAddress: null },
    });
    const digest = await service.sendToUser({
      userId: "user_1",
      title: "Portfolio today",
      body: "…",
      category: "portfolio_digest",
    });
    expect(digest.muted).toBe(true);
    const points = await service.sendToUser({
      userId: "user_1",
      title: "+10 points",
      body: "…",
      channelId: "points",
    });
    expect(points.attempted).toBe(1);
    expect(dispatchQueue.add).toHaveBeenCalledTimes(1);
  });

  it("two producers with the same dedupeKey are ONE notification — the second is dropped without a row", async () => {
    const { service, prisma, dispatchQueue } = buildHarness({
      walletSubs: [{ deviceToken: device }],
    });
    const key = "activity:0xhash:0xwallet";
    const first = await service.sendToWallet({
      walletAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      title: "Transfer Received",
      body: "from the sender's app",
      channelId: "transfers",
      dedupeKey: key,
    });
    const second = await service.sendToWallet({
      walletAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      title: "Transfer Received",
      body: "from the Zerion webhook",
      channelId: "transfers",
      dedupeKey: key,
    });
    expect(first.attempted).toBe(1);
    expect(second).toEqual({
      attempted: 0,
      notificationLogId: null,
      deduplicated: true,
    });
    expect(prisma.notificationLog.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
    expect(dispatchQueue.add).toHaveBeenCalledTimes(1);
  });

  it("a caller with a category but no channel gets the category's Android channel", async () => {
    const { service, prisma } = buildHarness({
      directDevices: [device],
      user: { id: "user_1", walletAddress: null },
    });
    await service.sendToUser({
      userId: "user_1",
      title: "t",
      body: "b",
      category: "payments",
    });
    const row = (
      prisma.notificationLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(row.channelId).toBe("payouts");
    expect(row.category).toBe("payments");
  });
});

describe("registerToken — new device", () => {
  const existing = { id: "dev_old", token: "ExponentPushToken[old]" };

  it("a never-seen token tells the wallet's OTHER devices, never the new one, once per wallet", async () => {
    const { service, prisma, dispatchQueue } = buildHarness({
      walletSubs: [{ deviceToken: existing }],
      seenDevice: null,
    });
    const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const result = await service.registerToken({
      userId: null,
      token: "ExponentPushToken[new]",
      platform: "ios",
      wallets: [wallet],
    });
    expect(result?.isNewDevice).toBe(true);
    // The security push is fire-and-forget; let it settle.
    await new Promise((r) => setImmediate(r));

    const staged = prisma.notificationLog.createMany.mock.calls.find(
      (c) =>
        (c[0] as { data: Array<Record<string, unknown>> }).data[0].source ===
        "new_device",
    );
    expect(staged).toBeDefined();
    const row = (staged![0] as { data: Array<Record<string, unknown>> })
      .data[0];
    expect(row.category).toBe("security");
    expect(row.title).toBe("Wallet active on a new device");
    expect(row.body).toContain("new iPhone");
    expect(row.targetDeviceIds).toEqual(["dev_old"]);
    expect(row.dedupeKey).toBe(`new-device:device_upserted:${wallet}`);
    expect(dispatchQueue.add).toHaveBeenCalledTimes(1);
  });

  it("a token seen before (re-registration, wallet list change) is not a new device", async () => {
    const { service, prisma } = buildHarness({
      walletSubs: [{ deviceToken: existing }],
      seenDevice: { id: "device_upserted" },
    });
    const result = await service.registerToken({
      userId: null,
      token: "ExponentPushToken[old]",
      platform: "ios",
      wallets: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    });
    expect(result?.isNewDevice).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(prisma.notificationLog.createMany).not.toHaveBeenCalled();
  });

  it("a new device with no other devices for the wallet rings nothing", async () => {
    const { service, prisma } = buildHarness({
      walletSubs: [],
      seenDevice: null,
    });
    await service.registerToken({
      userId: null,
      token: "ExponentPushToken[new]",
      platform: "android",
      wallets: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    });
    await new Promise((r) => setImmediate(r));
    expect(prisma.notificationLog.createMany).not.toHaveBeenCalled();
  });
});

describe("product pushes — purchases, bookings, merchant payouts", () => {
  const device = { id: "dev_1", token: "ExponentPushToken[abc]" };

  it("payment failure is worded from the buyer's side and keyed per purchase", async () => {
    const { service, prisma } = buildHarness({
      walletSubs: [{ deviceToken: device }],
    });
    await service.sendPurchaseOutcomePush({
      walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      purchaseId: "p1",
      bookingId: "b1",
      productName: "Steam Wallet 100k",
      outcome: "payment_failed",
    });
    const row = (
      prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(row.title).toBe("We couldn't verify your payment");
    expect(row.dedupeKey).toBe("purchase:p1:payment_failed");
    expect(row.category).toBe("payments");
  });

  it("fulfilment stages fire once each per order and only say 'ready' on delivered", async () => {
    const { service, prisma } = buildHarness({
      walletSubs: [{ deviceToken: device }],
    });
    const base = {
      walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      kind: "purchase" as const,
      id: "p1",
      productName: "Steam Wallet 100k",
    };
    await service.sendFulfilmentPush({
      ...base,
      stage: "paid",
      expectedMinutes: 30,
    });
    await service.sendFulfilmentPush({ ...base, stage: "delayed" });
    await service.sendFulfilmentPush({
      ...base,
      stage: "delivered",
      deliveryKind: "voucher",
    });
    await service.sendFulfilmentPush({
      ...base,
      stage: "refunded",
      points: 150000n,
    });
    const rows = prisma.notificationLog.createMany.mock.calls.map(
      (c) => (c[0] as { data: Array<Record<string, unknown>> }).data[0],
    );
    expect(rows.map((r) => r.title)).toEqual([
      "Payment received",
      "Taking longer than usual",
      "Your Steam Wallet 100k code is ready",
      "Refunded: 150,000 points",
    ]);
    // "paid" must not read as delivered.
    expect(rows[0].body).toContain("preparing");
    expect(rows[0].body).toContain("30 minutes");
    expect(rows.map((r) => r.dedupeKey)).toEqual([
      "fulfilment:purchase:p1:paid",
      "fulfilment:purchase:p1:delayed",
      "fulfilment:purchase:p1:delivered",
      "fulfilment:purchase:p1:refunded",
    ]);
    expect(rows.every((r) => r.category === "payments")).toBe(true);
    expect((rows[2].data as Record<string, unknown>).purchaseId).toBe("p1");
  });

  it("a top-up delivery names where it went; a redemption is keyed by redemptionId", async () => {
    const { service, prisma } = buildHarness({
      directDevices: [device],
      user: { walletAddress: null },
    });
    await service.sendFulfilmentPush({
      userId: "u1",
      kind: "redemption",
      id: "r1",
      productName: "Mobile Legends 86 Diamonds",
      stage: "delivered",
      deliveryKind: "topup",
      target: "0812••••1234",
    });
    const row = (
      prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(row.title).toBe("Mobile Legends 86 Diamonds delivered");
    expect(row.body).toContain("0812••••1234");
    expect(row.dedupeKey).toBe("fulfilment:redemption:r1:delivered");
    expect((row.data as Record<string, unknown>).redemptionId).toBe("r1");
    expect((row.data as Record<string, unknown>).type).toBe("redemption");
  });

  it("booking reminder carries a TTL that ends with the booking", async () => {
    const { service, prisma } = buildHarness({
      walletSubs: [{ deviceToken: device }],
    });
    await service.sendBookingExpiringPush({
      walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      bookingId: "b1",
      productName: "Mobile Legends 86 Diamonds",
      expiresAt: new Date(Date.now() + 120_000),
    });
    const row = (
      prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(row.title).toBe("Your price lock is about to expire");
    expect(row.body).toBe(
      "Complete your Mobile Legends 86 Diamonds purchase in the next 2 minutes to keep the locked price.",
    );
    expect(row.dedupeKey).toBe("booking-expiring:b1");
    const expiresAt = row.expiresAt as Date;
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(100_000);
  });

  it("merchant payout push goes to the merchant's user with the fiat amount first", async () => {
    const { service, prisma } = buildHarness({
      directDevices: [device],
      user: { id: "merchant_user", walletAddress: null },
      intent: {
        fiatAmountMinor: 48888,
        fiatCurrency: "IDR",
        merchant: {
          userId: "merchant_user",
          displayName: "GTron",
          payoutChannelCode: "BCA",
        },
      },
    });
    await service.sendMerchantPayoutPush("intent_1");
    const row = (
      prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data[0];
    expect(row.userId).toBe("merchant_user");
    expect(row.title).toBe("Payout received Rp 48.888");
    expect(row.body).toBe("A customer payment has landed in your BCA account.");
    expect(row.dedupeKey).toBe("merchant-payout:intent_1");
  });

  it("merchant without a linked user → nothing to send", async () => {
    const { service, prisma } = buildHarness({
      intent: {
        fiatAmountMinor: 1,
        fiatCurrency: "IDR",
        merchant: { userId: null },
      },
    });
    await service.sendMerchantPayoutPush("intent_1");
    expect(prisma.notificationLog.createMany).not.toHaveBeenCalled();
  });
});
