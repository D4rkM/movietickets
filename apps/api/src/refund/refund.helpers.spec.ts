import { buildRefundRequest, classifyRefundProviderError, REFUND_REQUEST_TIMEOUT_MS } from "./refund.helpers";

describe("refund helpers", () => {
  describe("buildRefundRequest", () => {
    it("should request a total refund of the Mercado Pago payment keyed by the refund row id", () => {
      // ARRANGE
      const refundId = "11111111-1111-4111-8111-111111111111";

      // ACT
      const request = buildRefundRequest("4242", refundId);

      // ASSERT
      expect(request).toEqual({
        payment_id: "4242",
        requestOptions: { idempotencyKey: refundId, timeout: 15_000 },
      });
      expect(request).not.toHaveProperty("body");
      expect(REFUND_REQUEST_TIMEOUT_MS).toBe(15_000);
    });
  });

  describe("classifyRefundProviderError", () => {
    it.each([
      ["409 (same key still processing)", { status: 409 }, { kind: "in_progress" }],
      ["400 with a cause code", { status: 400, cause: [{ code: 2063 }] }, { kind: "invalid", errorCode: "2063" }],
      ["404 without a cause", { status: 404 }, { kind: "invalid", errorCode: "404" }],
      ["a 5xx after the SDK's retries", { status: 503 }, { kind: "timeout" }],
      ["a connection error", { status: 0, message: "socket hang up" }, { kind: "timeout" }],
      ["an abort/timeout error", new Error("The operation was aborted due to timeout"), { kind: "timeout" }],
    ])("should classify %s", (_case, err, expected) => {
      // ARRANGE / ACT
      const failure = classifyRefundProviderError(err);

      // ASSERT
      expect(failure).toEqual(expected);
    });
  });
});
