import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, apiFetch, assertAuthorized, UnauthorizedError } from "./api-client";

describe("assertAuthorized", () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "stale-token");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("should throw UnauthorizedError and clear the stored token on a 401 response", () => {
    // ARRANGE
    const response = { status: 401 } as Response;

    // ACT
    const call = () => assertAuthorized(response);

    // ASSERT
    expect(call).toThrow(UnauthorizedError);
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("should do nothing for a non-401 response", () => {
    // ARRANGE
    const response = { status: 200 } as Response;

    // ACT
    const call = () => assertAuthorized(response);

    // ASSERT
    expect(call).not.toThrow();
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBe("stale-token");
  });
});

describe("apiFetch", () => {
  it("should send the ngrok-skip-browser-warning header, so an ngrok-tunneled API doesn't return its HTML interstitial", async () => {
    // ARRANGE
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // ACT
    await apiFetch("http://example.test/movies");

    // ASSERT
    const [, init] = fetchSpy.mock.calls[0];
    expect(new Headers(init?.headers).get("ngrok-skip-browser-warning")).toBe("true");

    fetchSpy.mockRestore();
  });

  it("should keep caller-provided headers alongside it", async () => {
    // ARRANGE
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // ACT
    await apiFetch("http://example.test/movies", { headers: { Authorization: "Bearer token" } });

    // ASSERT
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("ngrok-skip-browser-warning")).toBe("true");

    fetchSpy.mockRestore();
  });
});
