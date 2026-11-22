import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, UnauthorizedError, USER_STORAGE_KEY } from "../../lib/api-client";
import {
  createAdminMovie,
  createAdminSession,
  deleteAdminSession,
  listAdminSessions,
  listRefundReviewQueue,
  requestAdminRefund,
} from "./api";

describe("admin api client", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should surface the string message returned by the API on 409 Conflict", async () => {
    // ARRANGE
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          statusCode: 409,
          message: "Horário conflita com outra sessão na mesma sala",
        }),
      } as Response),
    );

    // ACT & ASSERT
    await expect(
      createAdminSession(
        {
          movieId: "m-1",
          roomId: "r-1",
          startsAt: "2026-12-20T22:00:00.000Z",
          priceCents: 3500,
        },
        "token-admin",
      ),
    ).rejects.toThrow("Horário conflita com outra sessão na mesma sala");
  });

  it("should join validation error array messages returned on 400 Bad Request", async () => {
    // ARRANGE
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          statusCode: 400,
          message: ["title must be longer than or equal to 1 characters", "durationMinutes must not be less than 1"],
        }),
      } as Response),
    );

    // ACT & ASSERT
    await expect(
      createAdminMovie({ title: "", durationMinutes: 0 }, "token-admin"),
    ).rejects.toThrow(
      "title must be longer than or equal to 1 characters, durationMinutes must not be less than 1",
    );
  });

  it("should clear stored credentials and throw UnauthorizedError on 401", async () => {
    // ARRANGE
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "expired-token");
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: "u-1", role: "admin" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      } as Response),
    );

    // ACT & ASSERT
    await expect(listAdminSessions("expired-token")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(USER_STORAGE_KEY)).toBeNull();
  });

  it("should resolve without body on 204 No Content when deleting a session", async () => {
    // ARRANGE
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal("fetch", fetchSpy);

    // ACT
    await deleteAdminSession("session-1", "token-admin");

    // ASSERT
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/sessions\/session-1$/),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("admin refunds api client", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should load the refund review queue with the admin token", async () => {
    // ARRANGE
    const queue = [{ bookingId: "b-1", reviewReason: "expired_booking_paid" }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => queue } as Response);
    vi.stubGlobal("fetch", fetchMock);

    // ACT
    const result = await listRefundReviewQueue("token-admin");

    // ASSERT
    expect(result).toEqual(queue);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/refunds\/review$/),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token-admin" }) }),
    );
  });

  it("should POST the admin refund and return the raw refund status", async () => {
    // ARRANGE
    const body = { bookingId: "b-1", bookingStatus: "expired", refund: { id: "r-1", status: "in_process", amountCents: 5000 } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);
    vi.stubGlobal("fetch", fetchMock);

    // ACT
    const result = await requestAdminRefund("b-1", "token-admin");

    // ASSERT
    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/admin\/bookings\/b-1\/refund$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    [409, "REFUND_NOT_ALLOWED", "Esta reserva não tem estorno pendente de revisão."],
    [409, "REFUND_IN_PROGRESS", "Já existe um estorno em andamento para este ingresso."],
    [422, "REFUND_REQUEST_INVALID", "Não foi possível solicitar o estorno agora. Seu ingresso continua válido."],
    [504, "REFUND_PROVIDER_TIMEOUT", "O provedor de pagamento não respondeu a tempo. Tente novamente."],
  ])("should surface the backend message on %i %s", async (status, code, message) => {
    // ARRANGE
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ statusCode: status, code, message }) } as Response),
    );

    // ACT
    const call = requestAdminRefund("b-1", "token-admin");

    // ASSERT
    await expect(call).rejects.toThrow(message);
  });
});
