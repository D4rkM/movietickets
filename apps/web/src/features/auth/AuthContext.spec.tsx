import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const SAMPLE_USER = { id: "user-1", name: "Ana", email: "user@test.com", role: "customer" };

describe("AuthContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should store the access token and user, persisting both to localStorage on successful login", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "token-123", user: SAMPLE_USER }),
    } as Response);
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // ACT
    await act(() => result.current.login("user@test.com", "password123"));

    // ASSERT
    await waitFor(() => expect(result.current.accessToken).toBe("token-123"));
    expect(result.current.user).toEqual(SAMPLE_USER);
    expect(localStorage.getItem("movietickets:accessToken")).toBe("token-123");
    expect(JSON.parse(localStorage.getItem("movietickets:user")!)).toEqual(SAMPLE_USER);
  });

  it("should restore the user from localStorage on mount", () => {
    // ARRANGE
    localStorage.setItem("movietickets:accessToken", "existing-token");
    localStorage.setItem("movietickets:user", JSON.stringify(SAMPLE_USER));

    // ACT
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // ASSERT
    expect(result.current.user).toEqual(SAMPLE_USER);
  });

  it("should clear the access token and user from state and localStorage on logout", async () => {
    // ARRANGE
    localStorage.setItem("movietickets:accessToken", "existing-token");
    localStorage.setItem("movietickets:user", JSON.stringify(SAMPLE_USER));
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // ACT
    act(() => result.current.logout());

    // ASSERT
    expect(result.current.accessToken).toBeNull();
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem("movietickets:accessToken")).toBeNull();
    expect(localStorage.getItem("movietickets:user")).toBeNull();
  });
});
