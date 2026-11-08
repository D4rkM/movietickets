import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, UnauthorizedError, USER_STORAGE_KEY } from "../../lib/api-client";
import { createAdminMovie, createAdminSession, deleteAdminSession, listAdminSessions } from "./api";

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
