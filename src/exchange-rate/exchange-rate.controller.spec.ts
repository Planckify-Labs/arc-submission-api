import { UserRole } from "@generated/prisma";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { ExchangeRateController } from "./exchange-rate.controller";

describe("ExchangeRateController", () => {
  it("lets only admins create a rate: rates set every token price", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, ExchangeRateController.prototype.create),
    ).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
  });
});
