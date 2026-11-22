import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { setActiveSpanAttributes, withRootSpan } from "./spans";

describe("telemetry spans", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;

  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  describe("withRootSpan", () => {
    it("should run the callback in a new root INTERNAL span, even inside another active span", async () => {
      // ARRANGE
      const outer = provider.getTracer("test").startSpan("outer");

      // ACT
      const result = await context.with(trace.setSpan(context.active(), outer), () =>
        withRootSpan("job.run", (span) => {
          span.setAttribute("job.items", 3);
          return "done";
        }),
      );
      outer.end();

      // ASSERT
      expect(result).toBe("done");
      const job = exporter.getFinishedSpans().find((span) => span.name === "job.run")!;
      expect(job.kind).toBe(SpanKind.INTERNAL);
      expect(job.parentSpanContext).toBeUndefined();
      expect(job.attributes).toEqual({ "job.items": 3 });
    });

    it("should make the root span the parent of spans started inside the callback", async () => {
      // ARRANGE
      const tracer = provider.getTracer("test");

      // ACT
      await withRootSpan("job.run", async () => {
        await Promise.resolve();
        tracer.startSpan("child").end();
      });

      // ASSERT
      const spans = exporter.getFinishedSpans();
      const job = spans.find((span) => span.name === "job.run")!;
      const child = spans.find((span) => span.name === "child")!;
      expect(child.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    });

    it("should mark the span as failed with error.type and rethrow when the callback throws", async () => {
      // ARRANGE
      const failure = new TypeError("boom");

      // ACT
      const run = withRootSpan("job.run", () => {
        throw failure;
      });

      // ASSERT
      await expect(run).rejects.toBe(failure);
      const [job] = exporter.getFinishedSpans();
      expect(job.status.code).toBe(SpanStatusCode.ERROR);
      expect(job.attributes["error.type"]).toBe("TypeError");
    });
  });

  describe("setActiveSpanAttributes", () => {
    it("should add the non-null attributes to the active span", () => {
      // ARRANGE
      const span = provider.getTracer("test").startSpan("request");

      // ACT
      context.with(trace.setSpan(context.active(), span), () =>
        setActiveSpanAttributes({ "payment.status": "rejected", "payment.status_detail": null }),
      );
      span.end();

      // ASSERT
      const [request] = exporter.getFinishedSpans();
      expect(request.attributes).toEqual({ "payment.status": "rejected" });
    });

    it("should do nothing when there is no active span", () => {
      // ARRANGE
      const attributes = { "payment.status": "approved" };

      // ACT
      const call = () => setActiveSpanAttributes(attributes);

      // ASSERT
      expect(call).not.toThrow();
      expect(exporter.getFinishedSpans()).toEqual([]);
    });
  });
});
