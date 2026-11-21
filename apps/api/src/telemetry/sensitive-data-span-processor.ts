import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace";

/**
 * Span attributes that carry personal data (client IP and user agent, LGPD).
 * The stable semconv names come first; the old pre-1.20 names are listed too
 * in case an instrumentation still emits them.
 */
export const PERSONAL_DATA_SPAN_ATTRIBUTES: readonly string[] = [
  "client.address",
  "network.peer.address",
  "user_agent.original",
  "http.client_ip",
  "http.user_agent",
  "net.peer.ip",
];

/**
 * drizzle-orm's `DrizzleQueryError` message is "Failed query: <sql>\nparams:
 * <values>", and instrumentations that record exceptions (e.g. nestjs-core)
 * copy that message into the span status and the exception event. The values
 * part runs until the stack frames (or the end of the text).
 */
const QUERY_PARAMS = /\nparams: [\s\S]*?(?=\n\s+at |$)/g;
const REDACTED_QUERY_PARAMS = "\nparams: [Redacted]";
const EXCEPTION_TEXT_ATTRIBUTES = ["exception.message", "exception.stacktrace"];

export function redactQueryParams(text: string): string {
  return text.replace(QUERY_PARAMS, REDACTED_QUERY_PARAMS);
}

/**
 * Last line of defense before export (decision D5 of the observability spec):
 * drops `PERSONAL_DATA_SPAN_ATTRIBUTES` and redacts SQL parameter values from
 * error messages. Uses the SDK's `onEnding` hook, which runs while the span is
 * still mutable and before any exporting processor sees it in `onEnd` — so it
 * must be registered before them.
 */
export class SensitiveDataSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of PERSONAL_DATA_SPAN_ATTRIBUTES) {
      delete attributes[key];
    }

    for (const event of span.events) {
      const eventAttributes = event.attributes as Record<string, unknown> | undefined;
      for (const key of EXCEPTION_TEXT_ATTRIBUTES) {
        const value = eventAttributes?.[key];
        if (typeof value === "string") {
          eventAttributes![key] = redactQueryParams(value);
        }
      }
    }

    if (span.status.message) {
      span.setStatus({ code: span.status.code, message: redactQueryParams(span.status.message) });
    }
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
