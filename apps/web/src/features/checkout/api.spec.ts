import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingExpiredError,
  getPaymentSummary,
  PaymentTimeoutError,
  submitPayment,
} from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("getPaymentSummary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should throw BookingExpiredError on a 409 with code BOOKING_EXPIRED", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(409, {
        statusCode: 409,
        code: "BOOKING_EXPIRED",
        message: "Reserva expirada. Escolha os assentos novamente.",
      }),
    );

    // ACT
    const result = getPaymentSummary("booking-1", "token-123");

    // ASSERT
    await expect(result).rejects.toBeInstanceOf(BookingExpiredError);
  });

  it.each([
    { scenario: "a 409 with another code", status: 409, body: { statusCode: 409, code: "BOOKING_NOT_PENDING" } },
    { scenario: "a 409 without a code", status: 409, body: { statusCode: 409 } },
    {
      scenario: "a 409 with a non-JSON body",
      status: 409,
      body: new SyntaxError("Unexpected token"),
    },
    { scenario: "a 500", status: 500, body: { statusCode: 500, code: "BOOKING_EXPIRED" } },
  ])("should throw a generic error (not BookingExpiredError) on $scenario", async ({ status, body }) => {
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
    const result = getPaymentSummary("booking-1", "token-123");

    // ASSERT
    await expect(result).rejects.toThrow(
      `Falha ao carregar o resumo da reserva booking-1 (status ${status})`,
    );
    await expect(result).rejects.not.toBeInstanceOf(BookingExpiredError);
  });

  it("should return the payment summary on success", async () => {
    // ARRANGE
    const summary = {
      bookingId: "booking-1",
      status: "pending",
      expiresAt: "2026-11-08T12:10:00.000Z",
      amountCents: 5000,
      currency: "BRL",
      description: "Filme X - A1",
      seats: [{ seatId: "seat-1", label: "A1", ticketType: "full" as const, priceCents: 5000 }],
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, summary));

    // ACT
    const result = await getPaymentSummary("booking-1", "token-123");

    // ASSERT
    expect(result).toEqual(summary);
  });
});

describe("submitPayment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sampleInput = {
    attemptId: "attempt-1",
    token: "card-token-1",
    paymentMethodId: "visa",
    issuerId: "25",
    installments: 1,
    payer: {
      email: "buyer@example.com",
      identification: { type: "CPF", number: "52998224725" },
    },
  };

  it("should throw PaymentTimeoutError when the network call fails", async () => {
    // ARRANGE
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    // ACT
    const result = submitPayment("booking-1", sampleInput, "token-123");

    // ASSERT
    await expect(result).rejects.toBeInstanceOf(PaymentTimeoutError);
  });

  it("should throw PaymentTimeoutError when the backend responds with 504", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(504, {
        statusCode: 504,
        code: "PAYMENT_PROVIDER_TIMEOUT",
        message: "Tempo esgotado no provedor.",
      }),
    );

    // ACT
    const result = submitPayment("booking-1", sampleInput, "token-123");

    // ASSERT
    await expect(result).rejects.toBeInstanceOf(PaymentTimeoutError);
  });

  it("should throw BookingExpiredError when the backend responds with 409 BOOKING_EXPIRED", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(409, {
        statusCode: 409,
        code: "BOOKING_EXPIRED",
        message: "Reserva expirada.",
      }),
    );

    // ACT
    const result = submitPayment("booking-1", sampleInput, "token-123");

    // ASSERT
    await expect(result).rejects.toBeInstanceOf(BookingExpiredError);
  });
});
