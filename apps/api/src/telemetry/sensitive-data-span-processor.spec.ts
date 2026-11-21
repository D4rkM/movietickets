import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { redactQueryParams, SensitiveDataSpanProcessor } from "./sensitive-data-span-processor";

describe("SensitiveDataSpanProcessor", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({
      spanProcessors: [new SensitiveDataSpanProcessor(), new SimpleSpanProcessor({ exporter })],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("should remove client IP and user agent attributes before the span is exported", () => {
    // ARRANGE
    const span = provider.getTracer("test").startSpan("GET /movies", {
      attributes: {
        "client.address": "203.0.113.7",
        "network.peer.address": "203.0.113.7",
        "user_agent.original": "Mozilla/5.0",
        "http.request.method": "GET",
      },
    });
    span.setAttribute("http.user_agent", "curl/8.0");

    // ACT
    span.end();

    // ASSERT
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes).toEqual({ "http.request.method": "GET" });
  });

  it("should keep spans without sensitive data untouched", () => {
    // ARRANGE
    const span = provider.getTracer("test").startSpan("SELECT bookings", {
      attributes: { "db.system.name": "postgresql", "db.operation.name": "SELECT" },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });

    // ACT
    span.end();

    // ASSERT
    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes).toEqual({ "db.system.name": "postgresql", "db.operation.name": "SELECT" });
    expect(exported.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
  });

  it("should redact query params from a recorded DrizzleQueryError and the span status", () => {
    // ARRANGE
    const error = new DrizzleQueryError(
      'select "id" from "users" where "users"."email" = $1',
      ["someone@example.com"],
      new Error("connection refused"),
    );
    const span = provider.getTracer("test").startSpan("POST /auth/login");
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

    // ACT
    span.end();

    // ASSERT
    const [exported] = exporter.getFinishedSpans();
    const serialized = JSON.stringify({ events: exported.events, status: exported.status });
    expect(serialized).not.toContain("someone@example.com");
    expect(exported.status.message).toBe(
      'Failed query: select "id" from "users" where "users"."email" = $1\nparams: [Redacted]',
    );
    expect(exported.events[0].attributes?.["exception.stacktrace"]).toMatch(/params: \[Redacted\]\n\s+at /);
  });

  it("should resolve forceFlush and shutdown without doing anything", async () => {
    // ARRANGE
    const processor = new SensitiveDataSpanProcessor();

    // ACT
    const results = await Promise.all([processor.forceFlush(), processor.shutdown()]);

    // ASSERT
    expect(results).toEqual([undefined, undefined]);
  });
});

describe("redactQueryParams", () => {
  it.each([
    { text: "Failed query: select 1\nparams: a,b", expected: "Failed query: select 1\nparams: [Redacted]" },
    {
      text: "Failed query: select 1\nparams: line1\nline2\n    at fn (file.js:1:1)",
      expected: "Failed query: select 1\nparams: [Redacted]\n    at fn (file.js:1:1)",
    },
    { text: "Sessão não encontrada", expected: "Sessão não encontrada" },
  ])("should turn $text into $expected", ({ text, expected }) => {
    // ARRANGE
    const input = text;

    // ACT
    const result = redactQueryParams(input);

    // ASSERT
    expect(result).toBe(expected);
  });
});
