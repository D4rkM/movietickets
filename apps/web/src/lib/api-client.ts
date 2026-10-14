export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * ngrok's free tier serves an HTML interstitial ("Visit Site") instead of the
 * real response on every request without this header — including fetch/XHR,
 * not just browser navigation — which breaks response.json() whenever API_URL
 * points at an ngrok tunnel (see README's ngrok section). No-op against a
 * direct backend: NestJS/Fastify ignore headers they don't recognize.
 */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "ngrok-skip-browser-warning": "true", ...init.headers },
  });
}

export const ACCESS_TOKEN_STORAGE_KEY = "movietickets:accessToken";
export const USER_STORAGE_KEY = "movietickets:user";

export class UnauthorizedError extends Error {
  constructor() {
    super("Sessão expirada. Faça login novamente.");
    this.name = "UnauthorizedError";
  }
}

/**
 * Clears the stored session and throws UnauthorizedError on a 401 response, so
 * a stale/expired token doesn't leave the user stuck behind a generic error —
 * callers should catch UnauthorizedError and redirect to /login.
 */
export function assertAuthorized(response: Response): void {
  if (response.status === 401) {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    throw new UnauthorizedError();
  }
}
