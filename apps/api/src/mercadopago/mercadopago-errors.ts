/**
 * Helpers to read Mercado Pago SDK errors. The SDK throws `MercadoPagoError`
 * subclasses carrying the HTTP `status` and the API's `cause` list (exposed as
 * `causes`); network failures and timeouts carry no usable HTTP status.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** HTTP status of a provider error, or `undefined` when there was no HTTP response (timeout, network). */
export function extractProviderHttpStatus(err: unknown): number | undefined {
  const record = asRecord(err);
  if (!record) return undefined;
  if (typeof record.status === "number" && record.status > 0) return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  const cause = asRecord(record.cause);
  if (cause) {
    if (typeof cause.status === "number" && cause.status > 0) return cause.status;
    if (typeof cause.statusCode === "number") return cause.statusCode;
  }
  return undefined;
}

/** First Mercado Pago error code (`cause[0].code`), falling back to `code`/`error` and then the HTTP status. */
export function extractProviderErrorCode(err: unknown, fallbackStatus: number): string {
  const record = asRecord(err);
  if (record) {
    for (const causes of [record.cause, record.causes]) {
      if (Array.isArray(causes) && causes.length > 0) {
        const firstCause = asRecord(causes[0]);
        if (firstCause?.code != null) return String(firstCause.code);
      }
    }
    if (typeof record.code === "string" || typeof record.code === "number") {
      return String(record.code);
    }
    if (typeof record.error === "string") {
      return record.error;
    }
  }
  return String(fallbackStatus);
}
