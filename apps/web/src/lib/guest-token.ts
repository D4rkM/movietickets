import { API_URL, apiFetch } from "./api-client";

/**
 * Guest identity lives in its own key, apart from the user's access token, so
 * ProtectedRoute (which only reads the user token) never treats a visitor as
 * logged in.
 */
export const GUEST_TOKEN_STORAGE_KEY = "movietickets:guestToken";

/**
 * A token this close to expiring is treated as already expired, so a request
 * started right before the deadline doesn't get a 401 halfway through.
 */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

export interface StoredGuestToken {
  guestToken: string;
  expiresAt: string;
}

export function storeGuestToken(token: StoredGuestToken): void {
  localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, JSON.stringify(token));
}

export function clearGuestToken(): void {
  localStorage.removeItem(GUEST_TOKEN_STORAGE_KEY);
}

/** Returns the stored guest token while it is still valid; drops it once expired or malformed. */
export function readValidGuestToken(now: number = Date.now()): string | null {
  const raw = localStorage.getItem(GUEST_TOKEN_STORAGE_KEY);
  if (!raw) return null;

  try {
    const { guestToken, expiresAt } = JSON.parse(raw) as Partial<StoredGuestToken>;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (typeof guestToken === "string" && expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > now) {
      return guestToken;
    }
  } catch {
    // Malformed entry: fall through and drop it.
  }

  clearGuestToken();
  return null;
}

/**
 * Reads the `sub` claim (`guest:<uuid>`) without verifying the signature: it's
 * only used to tell which seat-hold broadcasts belong to this visitor, never
 * for authorization (the API verifies the token on every call).
 */
export function readTokenSubject(token: string): string | null {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function requestGuestToken(): Promise<StoredGuestToken> {
  const response = await apiFetch(`${API_URL}/auth/guest`, { method: "POST" });

  if (!response.ok) {
    throw new Error(`Falha ao iniciar a sessão de visitante (status ${response.status})`);
  }

  return response.json();
}

// Shared while a request is in flight, so two callers mounting at once (e.g.
// StrictMode's double effect) don't mint two guest identities.
let pendingRequest: Promise<string> | null = null;

/** Reuses the stored guest token while valid; otherwise asks the API for a new one and stores it. */
export function ensureGuestToken(): Promise<string> {
  const stored = readValidGuestToken();
  if (stored) return Promise.resolve(stored);

  pendingRequest ??= requestGuestToken()
    .then((issued) => {
      storeGuestToken(issued);
      return issued.guestToken;
    })
    .finally(() => {
      pendingRequest = null;
    });
  return pendingRequest;
}
