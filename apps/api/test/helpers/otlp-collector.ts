import { createServer, IncomingMessage, Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Fake OTLP/HTTP collector for the observability smoke test: stores every JSON
 * payload POSTed to /v1/traces, /v1/metrics and /v1/logs. The API under test
 * runs with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, so nothing needs protobuf
 * decoding. Only the bits of the OTLP JSON shape the tests read are typed.
 */

type Signal = "traces" | "metrics" | "logs";

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
}

export interface CollectedLogRecord {
  traceId?: string;
  spanId?: string;
  body: unknown;
  attributes: Record<string, unknown>;
}

export interface CollectedDataPoint {
  metric: string;
  attributes: Record<string, unknown>;
}

/** OTLP span kinds (`SPAN_KIND_*` in the proto enum). */
export const OTLP_SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;

export interface FakeOtlpCollector {
  /** Base URL to use as OTEL_EXPORTER_OTLP_ENDPOINT. */
  url: string;
  spans: () => CollectedSpan[];
  logRecords: () => CollectedLogRecord[];
  dataPoints: (metric: string) => CollectedDataPoint[];
  /** Every payload received so far, as raw text (for "never contains X" checks). */
  rawPayloads: () => string;
  requestCount: () => number;
  close: () => Promise<void>;
}

function toValue(value: OtlpAnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return value;
}

function toAttributes(list: OtlpKeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map(({ key, value }) => [key, toValue(value)]));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- OTLP JSON payloads are walked loosely. */
export async function startFakeOtlpCollector(): Promise<FakeOtlpCollector> {
  const payloads: Record<Signal, any[]> = { traces: [], metrics: [], logs: [] };
  const raw: string[] = [];

  const server: Server = createServer(async (request, response) => {
    const body = await readBody(request);
    const signal = request.url?.replace(/^\/v1\//, "") as Signal;
    if (request.method === "POST" && signal in payloads) {
      raw.push(body);
      payloads[signal].push(JSON.parse(body));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const spans = (): CollectedSpan[] =>
    payloads.traces.flatMap((payload) =>
      (payload.resourceSpans ?? []).flatMap((rs: any) =>
        (rs.scopeSpans ?? []).flatMap((ss: any) =>
          (ss.spans ?? []).map((span: any) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId || undefined,
            name: span.name,
            kind: span.kind,
            attributes: toAttributes(span.attributes),
          })),
        ),
      ),
    );

  const logRecords = (): CollectedLogRecord[] =>
    payloads.logs.flatMap((payload) =>
      (payload.resourceLogs ?? []).flatMap((rl: any) =>
        (rl.scopeLogs ?? []).flatMap((sl: any) =>
          (sl.logRecords ?? []).map((record: any) => ({
            traceId: record.traceId || undefined,
            spanId: record.spanId || undefined,
            body: toValue(record.body),
            attributes: toAttributes(record.attributes),
          })),
        ),
      ),
    );

  const dataPoints = (metric: string): CollectedDataPoint[] =>
    payloads.metrics.flatMap((payload) =>
      (payload.resourceMetrics ?? []).flatMap((rm: any) =>
        (rm.scopeMetrics ?? []).flatMap((sm: any) =>
          (sm.metrics ?? [])
            .filter((m: any) => m.name === metric)
            .flatMap((m: any) => {
              const points = m.histogram?.dataPoints ?? m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
              return points.map((point: any) => ({ metric, attributes: toAttributes(point.attributes) }));
            }),
        ),
      ),
    );

  return {
    url: `http://127.0.0.1:${port}`,
    spans,
    logRecords,
    dataPoints,
    rawPayloads: () => raw.join("\n"),
    requestCount: () => raw.length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Polls `find` until it returns something truthy, or fails after `timeoutMs`. */
export async function waitFor<T>(description: string, find: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
