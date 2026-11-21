import { extractProviderErrorCode, extractProviderHttpStatus } from "./mercadopago-errors";

describe("Mercado Pago error helpers", () => {
  describe("extractProviderHttpStatus", () => {
    it.each([
      ["a top-level status", { status: 400 }, 400],
      ["a top-level statusCode", { statusCode: 404 }, 404],
      ["a status on the cause object", { cause: { status: 409 } }, 409],
      ["a statusCode on the cause object", { cause: { statusCode: 422 } }, 422],
      ["a connection error with status 0", { status: 0 }, undefined],
      ["a plain error", new Error("socket hang up"), undefined],
      ["a non-object", "boom", undefined],
      ["null", null, undefined],
    ])("should read %s", (_case, err, expected) => {
      // ARRANGE / ACT
      const status = extractProviderHttpStatus(err);

      // ASSERT
      expect(status).toBe(expected);
    });
  });

  describe("extractProviderErrorCode", () => {
    it.each([
      ["the first cause code", { cause: [{ code: 2063 }] }, "2063"],
      ["the first code of the SDK's causes list", { causes: [{ code: "4296" }] }, "4296"],
      ["a top-level code", { code: "bad_request" }, "bad_request"],
      ["a top-level error string", { error: "invalid_token" }, "invalid_token"],
      ["the HTTP status when nothing else is there", {}, "400"],
      ["the HTTP status for a non-object", "boom", "400"],
    ])("should return %s", (_case, err, expected) => {
      // ARRANGE / ACT
      const code = extractProviderErrorCode(err, 400);

      // ASSERT
      expect(code).toBe(expected);
    });
  });
});
