import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, UnauthorizedError } from "../../lib/api-client";
import { CancelBookingError, cancelBooking } from "./api";

function jsonResponse(body: unknown, status: number): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("cancelBooking", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should POST to the cancel endpoint and return the cancellation with its refund", async () => {
    // ARRANGE
    const body = { bookingId: "b-1", status: "cancelled", refund: { id: "r-1", status: "pending", amountCents: 5000 } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, 200));
    vi.stubGlobal("fetch", fetchMock);

    // ACT
    const result = await cancelBooking("b-1", "token-1");

    // ASSERT
    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/bookings\/b-1\/cancel$/),
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer token-1" }) }),
    );
  });

  it.each([
    [409, "CANCELLATION_DEADLINE_PASSED", "O cancelamento só é permitido até 2 horas antes do início da sessão.", false],
    [409, "REFUND_IN_PROGRESS", "Já existe um estorno em andamento para este ingresso.", false],
    [409, "BOOKING_NOT_CANCELLABLE", "Só é possível cancelar ingressos confirmados.", false],
    [422, "REFUND_REQUEST_INVALID", "Não foi possível solicitar o estorno agora. Seu ingresso continua válido.", false],
    [422, "REFUND_REJECTED", "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.", false],
    [504, "REFUND_PROVIDER_TIMEOUT", "O provedor de pagamento não respondeu a tempo. Tente novamente.", true],
  ])("should throw a CancelBookingError for %i %s with the backend message", async (status, code, message, retryable) => {
    // ARRANGE
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ statusCode: status, code, message }, status)));

    // ACT
    const error = await cancelBooking("b-1", "token-1").catch((err: unknown) => err);

    // ASSERT
    expect(error).toBeInstanceOf(CancelBookingError);
    expect(error).toMatchObject({ status, code, message, retryable });
  });

  it("should fall back to a status message when the error body is not JSON", async () => {
    // ARRANGE
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      } as unknown as Response),
    );

    // ACT
    const error = await cancelBooking("b-1", "token-1").catch((err: unknown) => err);

    // ASSERT
    expect(error).toBeInstanceOf(CancelBookingError);
    expect(error).toMatchObject({ status: 500, code: undefined, message: "Falha ao cancelar o ingresso (status 500)" });
  });

  it("should throw a retryable CancelBookingError when the request never reaches the server", async () => {
    // ARRANGE
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    // ACT
    const error = await cancelBooking("b-1", "token-1").catch((err: unknown) => err);

    // ASSERT
    expect(error).toBeInstanceOf(CancelBookingError);
    expect((error as CancelBookingError).retryable).toBe(true);
  });

  it("should throw UnauthorizedError and clear the session on 401", async () => {
    // ARRANGE
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "stale");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ statusCode: 401 }, 401)));

    // ACT
    const call = cancelBooking("b-1", "stale");

    // ASSERT
    await expect(call).rejects.toBeInstanceOf(UnauthorizedError);
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
