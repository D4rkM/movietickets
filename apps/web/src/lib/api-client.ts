export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const ACCESS_TOKEN_STORAGE_KEY = "movietickets:accessToken";

export class UnauthorizedError extends Error {
  constructor() {
    super("Sessão expirada. Faça login novamente.");
    this.name = "UnauthorizedError";
  }
}

/**
 * Clears the stored token and throws UnauthorizedError on a 401 response, so a
 * stale/expired token doesn't leave the user stuck behind a generic error —
 * callers should catch UnauthorizedError and redirect to /login.
 */
export function assertAuthorized(response: Response): void {
  if (response.status === 401) {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    throw new UnauthorizedError();
  }
}
