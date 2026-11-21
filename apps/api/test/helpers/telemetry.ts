import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  DataPoint,
  Histogram,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, ReadableSpan, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { databaseNameFromUrl, instrumentDrizzle } from "../../src/telemetry/drizzle-tracing";

/**
 * In-memory OpenTelemetry for Jest integration tests: a TracerProvider and a
 * MeterProvider with in-memory exporters, an AsyncLocalStorage context manager
 * (so parent/child spans survive `await`) and the Drizzle tracing patch
 * applied to this test file's drizzle-orm module instance.
 */
export interface TestTelemetry {
  /** Runs `fn` inside a SERVER-like parent span, standing in for an HTTP request. */
  insideRequestSpan: <T>(fn: () => Promise<T>) => Promise<{ result: T; requestSpanId: string; traceId: string }>;
  spans: () => ReadableSpan[];
  spansOfTrace: (traceId: string) => ReadableSpan[];
  /** Histogram points of `metric` aggregated so far (cumulative). */
  dataPoints: (metric: string) => Promise<DataPoint<Histogram>[]>;
  reset: () => void;
  shutdown: () => Promise<void>;
}

export function startTestTelemetry(): TestTelemetry {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
  const meterProvider = new MeterProvider({ readers: [metricReader] });

  instrumentDrizzle({ databaseUrl: process.env.DATABASE_URL, tracerProvider, meterProvider });

  const tracer = tracerProvider.getTracer("test-request");

  return {
    insideRequestSpan: (fn) =>
      tracer.startActiveSpan("test request", async (span) => {
        try {
          const result = await fn();
          return { result, requestSpanId: span.spanContext().spanId, traceId: span.spanContext().traceId };
        } finally {
          span.end();
        }
      }),
    spans: () => spanExporter.getFinishedSpans(),
    spansOfTrace: (traceId) => spanExporter.getFinishedSpans().filter((span) => span.spanContext().traceId === traceId),
    dataPoints: async (metric) => {
      await metricReader.forceFlush();
      // Cumulative temporality: the latest export holds everything so far.
      return (metricExporter.getMetrics().at(-1)?.scopeMetrics ?? [])
        .flatMap((sm) => sm.metrics)
        .filter((m) => m.descriptor.name === metric)
        .flatMap((m) => m.dataPoints as DataPoint<Histogram>[]);
    },
    reset: () => {
      spanExporter.reset();
      metricExporter.reset();
    },
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
      trace.disable();
      context.disable();
    },
  };
}

/** Everything an exporter would ship for `span` (name, attributes, status, events), as text. */
export function exportedContent(span: ReadableSpan): string {
  return JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status, events: span.events });
}

/** `db.namespace` the Drizzle patch records for this run: the database name in DATABASE_URL. */
export function expectedDbNamespace(): string | undefined {
  return databaseNameFromUrl(process.env.DATABASE_URL);
}
