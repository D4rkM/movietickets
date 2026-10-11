export interface CorsOptions {
  origin: string | string[];
  methods: string[];
}

/**
 * Shared with cors.e2e-spec.ts so the test exercises the exact same config
 * main.ts boots with, instead of a hand-copied one that can drift out of sync.
 */
export function corsOptions(): CorsOptions {
  return {
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    // Fastify's CORS default only allows GET/HEAD/POST — seat/hold release (DELETE
    // /sessions/:id/seats/:seatId/hold, DELETE /sessions/:id/holds) and booking
    // cancellation need DELETE explicitly listed, or the browser's preflight
    // rejects them before the request ever reaches the server.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  };
}
