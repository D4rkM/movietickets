import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureGuestToken,
  GUEST_TOKEN_STORAGE_KEY,
  readTokenSubject,
  readValidGuestToken,
  storeGuestToken,
} from "./guest-token";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function fakeJwt(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("readValidGuestToken", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("should return the stored token while it has not expired", () => {
    // ARRANGE
    storeGuestToken({ guestToken: "guest-token", expiresAt: new Date(NOW + 60 * 60_000).toISOString() });

    // ACT
    const token = readValidGuestToken(NOW);

    // ASSERT
    expect(token).toBe("guest-token");
  });

  it.each([
    ["already expired", NOW - 1_000],
    ["expiring within the safety margin", NOW + 5_000],
  ])("should drop the stored token when it is %s", (_label, expiresAtMs) => {
    // ARRANGE
    storeGuestToken({ guestToken: "guest-token", expiresAt: new Date(expiresAtMs).toISOString() });

    // ACT
    const token = readValidGuestToken(NOW);

    // ASSERT
    expect(token).toBeNull();
    expect(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it.each([["not-json"], [JSON.stringify({ guestToken: "x" })], [JSON.stringify({ expiresAt: "2099-01-01" })]])(
    "should drop a malformed stored entry %s",
    (raw) => {
      // ARRANGE
      localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, raw);

      // ACT
      const token = readValidGuestToken(NOW);

      // ASSERT
      expect(token).toBeNull();
      expect(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)).toBeNull();
    },
  );
});

describe("readTokenSubject", () => {
  it("should read the sub claim of a JWT", () => {
    // ARRANGE
    const token = fakeJwt({ kind: "guest", sub: "guest:1234" });

    // ACT
    const subject = readTokenSubject(token);

    // ASSERT
    expect(subject).toBe("guest:1234");
  });

  it.each([["not-a-jwt"], ["a.%%%.c"], [fakeJwt({ kind: "guest" })]])(
    "should return null for a token without a readable sub (%s)",
    (token) => {
      // ARRANGE — token from the table

      // ACT
      const subject = readTokenSubject(token);

      // ASSERT
      expect(subject).toBeNull();
    },
  );
});

describe("ensureGuestToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should reuse a valid stored token without calling the API", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: "stored-token", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });

    // ACT
    const token = await ensureGuestToken();

    // ASSERT
    expect(token).toBe("stored-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should request a new token, store it, and share one request between concurrent callers", async () => {
    // ARRANGE
    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ guestToken: "new-token", expiresAt }),
    } as Response);

    // ACT
    const [first, second] = await Promise.all([ensureGuestToken(), ensureGuestToken()]);

    // ASSERT
    expect(first).toBe("new-token");
    expect(second).toBe("new-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/guest"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)!)).toEqual({ guestToken: "new-token", expiresAt });
  });

  it("should reject and store nothing when the API fails", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as Response);

    // ACT
    const call = ensureGuestToken();

    // ASSERT
    await expect(call).rejects.toThrow("status 429");
    expect(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
