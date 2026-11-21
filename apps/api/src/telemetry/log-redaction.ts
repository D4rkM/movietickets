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
