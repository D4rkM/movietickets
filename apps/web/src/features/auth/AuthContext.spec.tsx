import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

describe("AuthContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should store the access token and persist it to localStorage on successful login", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "token-123" }),
    } as Response);
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // ACT
    await act(() => result.current.login("user@test.com", "password123"));

    // ASSERT
    await waitFor(() => expect(result.current.accessToken).toBe("token-123"));
    expect(localStorage.getItem("movietickets:accessToken")).toBe("token-123");
  });

  it("should clear the access token from state and localStorage on logout", async () => {
    // ARRANGE
    localStorage.setItem("movietickets:accessToken", "existing-token");
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // ACT
    act(() => result.current.logout());

    // ASSERT
    expect(result.current.accessToken).toBeNull();
    expect(localStorage.getItem("movietickets:accessToken")).toBeNull();
  });
});
