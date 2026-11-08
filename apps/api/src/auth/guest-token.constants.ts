/** Guest tokens live 2h; a stored one is reused by the front until it expires. */
export const GUEST_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/** POST /auth/guest: at most 10 tokens per minute per IP. */
export const GUEST_TOKEN_RATE_LIMIT = { name: "guest-token", ttl: 60_000, limit: 10 };
