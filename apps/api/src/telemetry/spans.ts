import { AttributeValue, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

/** Tracer for spans opened by our own code (work outside an HTTP request). */
const TRACER_NAME = "movietickets-api";

/** The only span operations business code needs. */
export interface SpanHandle {
  setAttribute(key: string, value: AttributeValue): void;
}

/**
 * Runs `fn` inside a new root INTERNAL span named `name`, for work that runs
 * outside any request (sweeper tick, hold expiry): the Drizzle/Valkey spans it
 * produces become children of this one instead of floating loose. `trace`
 * returns a proxy tracer, so with telemetry off this is a cheap no-op span.
 * A thrown error marks the span as failed (with `error.type`) and is rethrown.
 */
export async function withRootSpan<T>(name: string, fn: (span: SpanHandle) => Promise<T> | T): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { root: true, kind: SpanKind.INTERNAL }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("error.type", err instanceof Error ? err.constructor.name : "Error");
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Adds low-risk attributes to the currently active span (the request span),
 * e.g. Mercado Pago's `status_detail`. No-op when there is no active span.
 * Never pass personal data here (see the spec's privacy rules).
 */
export function setActiveSpanAttributes(attributes: Record<string, AttributeValue | null | undefined>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null) span.setAttribute(key, value);
  }
}
