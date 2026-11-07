jest.mock("expo-server-sdk", () => ({ Expo: class {} }));
// The controller imports these through the `src/...` alias, which jest does
// not map; stub them (virtual) so the spec can load it without the auth stack.
jest.mock("src/auth/guards/jwt-auth.guard", () => ({ JwtAuthGuard: class {} }), {
  virtual: true,
});
jest.mock("src/auth/guards/roles.guard", () => ({ RolesGuard: class {} }), {
  virtual: true,
});
jest.mock(
  "src/decorators/roles.decorator",
  () => ({ Roles: () => () => undefined }),
  { virtual: true },
);

import { BadRequestException, Logger } from "@nestjs/common";
import { PurchasesController } from "./purchases.controller";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-payload.sig";

function build() {
  const purchasesService = {
    getReferenceIdWithPurchase: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: "pur_1" })),
  };
  const controller = new PurchasesController(
    purchasesService as never,
    {} as never,
  );
  const res = {
    req: {
      headers: { authorization: BEARER },
      method: "POST",
      url: "/purchases",
      ip: "127.0.0.1",
    },
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  const dto = {
    refId: "ref_1",
    bookingId: "book_1",
    walletAddress: WALLET,
    networkId: "bc_1",
    contractAddress: "0xC0ffee254729296a45a3885639AC7E10F9d54979",
    transactionHash: "0xhash",
  };
  return { controller, purchasesService, res, dto };
}

describe("PurchasesController.create logging", () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(),
    );
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  const logged = () =>
    JSON.stringify(spies.flatMap((s) => s.mock.calls));

  it("never writes the bearer token or the request headers to the logs", async () => {
    const { controller, res, dto } = build();
    await controller.create(dto as never, { user: { walletAddress: WALLET } }, res as never);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(logged()).not.toContain("super-secret-payload");
    expect(logged()).not.toContain("authorization");
  });

  it("does not log the whole DTO either", async () => {
    const { controller, res, dto } = build();
    await controller.create(dto as never, { user: { walletAddress: WALLET } }, res as never);
    expect(logged()).not.toContain(dto.transactionHash);
  });

  it("still refuses a wallet that is not the caller's", async () => {
    const { controller, res, dto, purchasesService } = build();
    await expect(
      controller.create(
        dto as never,
        { user: { walletAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" } },
        res as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(purchasesService.create).not.toHaveBeenCalled();
  });
});
