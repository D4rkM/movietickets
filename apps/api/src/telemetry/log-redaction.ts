/**
 * pino `redact` paths for the HTTP logger (`LoggerModule` in app.module.ts).
 * Redaction happens while pino serializes the record, so the OTel pino
 * instrumentation (which ships that same serialized record to Loki) never sees
 * the original values either. See "Privacidade e segurança" in
 * docs/flows/observability/spec.md.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "req.body.password",
  "req.body.guestToken",
  "req.body.token",
  "req.body.payer",
];

/** Request headers that identify the client (personal data, LGPD) and never go to logs. */
export const LOG_REMOVED_REQUEST_HEADERS: readonly string[] = ["user-agent", "x-forwarded-for", "x-real-ip"];

/** Fields of the serialized request that identify the client's network address. */
const LOG_REMOVED_REQUEST_FIELDS: readonly string[] = ["remoteAddress", "remotePort"];

/**
 * Custom pino-http `req` serializer: drops the client IP/port and the
 * user-agent/forwarding headers from the serialized request instead of masking
 * them, so they appear neither in stdout nor in the OTLP export to Loki.
 * pino-http hands it the already-serialized request (standard shape).
 * Secrets stay masked as `[Redacted]` through LOG_REDACT_PATHS.
 */
export function omitClientIdentity<T extends { headers?: Record<string, unknown> }>(serializedReq: T): T {
  const copy: Record<string, unknown> = { ...serializedReq };
  for (const field of LOG_REMOVED_REQUEST_FIELDS) delete copy[field];
  if (serializedReq.headers) {
    const headers = { ...serializedReq.headers };
    for (const header of LOG_REMOVED_REQUEST_HEADERS) delete headers[header];
    copy.headers = headers;
  }
  return copy as T;
}
