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
  meterProvider: MeterProvider;
  /** Runs `fn` inside a SERVER-like parent span, standing in for an HTTP request. */
  insideRequestSpan: <T>(fn: () => Promise<T>) => Promise<{ result: T; requestSpanId: string; traceId: string }>;
  spans: () => ReadableSpan[];
  spansOfTrace: (traceId: string) => ReadableSpan[];
  /** Histogram points of `metric` aggregated so far (cumulative). */
  dataPoints: (metric: string) => Promise<DataPoint<Histogram>[]>;
  /** Every point of `metric` aggregated so far (cumulative), whatever its type. */
  metricPoints: (metric: string) => Promise<DataPoint<number | Histogram>[]>;
  /** Every metric name recorded so far, with its points. */
  allMetrics: () => Promise<Map<string, DataPoint<number | Histogram>[]>>;
  reset: () => void;
  shutdown: () => Promise<void>;
}

export interface StartTestTelemetryOptions {
  /**
   * Also registers the in-memory TracerProvider as the global one, so spans our
   * code opens through `@opentelemetry/api` (e.g. `withRootSpan`) land in it.
   */
  registerGlobalTracer?: boolean;
}

export function startTestTelemetry(options: StartTestTelemetryOptions = {}): TestTelemetry {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
  if (options.registerGlobalTracer) {
    trace.setGlobalTracerProvider(tracerProvider);
  }
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
  const meterProvider = new MeterProvider({ readers: [metricReader] });

  instrumentDrizzle({ databaseUrl: process.env.DATABASE_URL, tracerProvider, meterProvider });

  const tracer = tracerProvider.getTracer("test-request");

  const allMetrics = async () => {
    await metricReader.forceFlush();
    // Cumulative temporality: the latest export holds everything so far.
    const byName = new Map<string, DataPoint<number | Histogram>[]>();
    for (const scope of metricExporter.getMetrics().at(-1)?.scopeMetrics ?? []) {
      for (const metric of scope.metrics) {
        byName.set(metric.descriptor.name, [
          ...(byName.get(metric.descriptor.name) ?? []),
          ...(metric.dataPoints as DataPoint<number | Histogram>[]),
        ]);
      }
    }
    return byName;
  };

  return {
    meterProvider,
    allMetrics,
    metricPoints: async (metric) => (await allMetrics()).get(metric) ?? [],
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

/** Which number of a histogram point to read: how many values it got, or their sum. */
export type HistogramField = "count" | "sum";

/**
 * Sum of a counter/up-down counter over the points matching `attributes`; for a
 * histogram, the sum of `histogramField` (count of recorded values by default).
 */
export async function metricValue(
  telemetry: TestTelemetry,
  metric: string,
  attributes: Record<string, string> = {},
  histogramField: HistogramField = "count",
): Promise<number> {
  const points = await telemetry.metricPoints(metric);
  return points
    .filter((point) => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value))
    .reduce(
      (sum, point) => sum + (typeof point.value === "number" ? point.value : (point.value[histogramField] ?? 0)),
      0,
    );
}

export interface MetricWatch {
  /** How much the watched value grew since the watch started. */
  increase: () => Promise<number>;
  /** Polls until the increase equals `expected` (async emitters such as WebSocket handlers); returns the last increase. */
  settlesAt: (expected: number, timeoutMs?: number) => Promise<number>;
}

/**
 * Snapshots a metric now so a test can assert how much one action moved it.
 * Metrics are cumulative and shared by every test of the file, so tests read
 * increases, never absolute values.
 */
export async function watchMetric(
  telemetry: TestTelemetry,
  metric: string,
  attributes: Record<string, string> = {},
  histogramField: HistogramField = "count",
): Promise<MetricWatch> {
  const read = () => metricValue(telemetry, metric, attributes, histogramField);
  const baseline = await read();
  const increase = async () => (await read()) - baseline;
  return {
    increase,
    settlesAt: async (expected, timeoutMs = 3000) => {
      const started = Date.now();
      for (;;) {
        const grown = await increase();
        if (grown === expected || Date.now() - started > timeoutMs) return grown;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
