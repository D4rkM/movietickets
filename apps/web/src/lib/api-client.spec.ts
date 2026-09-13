import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, assertAuthorized, UnauthorizedError } from "./api-client";

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
