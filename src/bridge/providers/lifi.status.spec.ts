import { isLifiNotFound } from "./lifi.adapter";

describe("isLifiNotFound", () => {
  it("finds the 404 the SDK wraps in an SDKError", () => {
    const http = Object.assign(new Error("Not Found"), { status: 404 });
    const sdk = Object.assign(new Error("[HTTPError] Not Found"), {
      cause: http,
    });
    expect(isLifiNotFound(sdk)).toBe(true);
  });
  it("leaves every other failure a network error", () => {
    const http = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(isLifiNotFound(Object.assign(new Error("x"), { cause: http }))).toBe(
      false,
    );
    expect(isLifiNotFound(new Error("socket hang up"))).toBe(false);
    expect(isLifiNotFound(undefined)).toBe(false);
  });
});
