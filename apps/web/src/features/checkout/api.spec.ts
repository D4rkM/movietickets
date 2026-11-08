import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingExpiredError, createCheckout } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("createCheckout", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC16: should throw BookingExpiredError on a 409 with code BOOKING_EXPIRED", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(409, {
        statusCode: 409,
        code: "BOOKING_EXPIRED",
        message: "Reserva expirada. Escolha os assentos novamente.",
      }),
    );

    // ACT
    const result = createCheckout("booking-1", "token-123");

    // ASSERT
    await expect(result).rejects.toBeInstanceOf(BookingExpiredError);
  });

  it.each([
    { scenario: "a 409 with another code", status: 409, body: { statusCode: 409, code: "SEAT_TAKEN" } },
    { scenario: "a 409 without a code", status: 409, body: { statusCode: 409, message: "Conflict" } },
    {
      scenario: "a 409 with a non-JSON body",
      status: 409,
      body: new SyntaxError("Unexpected token"),
    },
    { scenario: "a 500", status: 500, body: { statusCode: 500, code: "BOOKING_EXPIRED" } },
  ])("AC16: should throw a generic error (not BookingExpiredError) on $scenario", async ({ status, body }) => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    } as Response);

    // ACT
    const result = createCheckout("booking-1", "token-123");

    // ASSERT
    await expect(result).rejects.toThrow(`Falha ao criar o checkout da reserva booking-1 (status ${status})`);
    await expect(result).rejects.not.toBeInstanceOf(BookingExpiredError);
  });

  it("should return the checkout URL on success", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { checkoutUrl: "https://mp.test/checkout/abc" }));

    // ACT
    const result = await createCheckout("booking-1", "token-123");

    // ASSERT
    expect(result).toEqual({ checkoutUrl: "https://mp.test/checkout/abc" });
  });
});
