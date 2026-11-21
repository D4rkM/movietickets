import { FastifyOtelInstrumentation } from "@fastify/otel";
import { diag } from "@opentelemetry/api";
import { OTLPTraceExporter as OtlpHttpJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OtlpProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { SocketIoInstrumentation } from "@opentelemetry/instrumentation-socket.io";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import { SensitiveDataSpanProcessor } from "./sensitive-data-span-processor";

/**
 * The only module that loads the OpenTelemetry SDK and instrumentations. It's
 * required by `instrumentation.ts` only after `shouldStartTelemetry` said yes,
 * so with telemetry off none of this code is even loaded.
 */

type Env = Record<string, string | undefined>;

const OTLP_EXPORT_PATH = /\/v1\/(traces|metrics|logs)$/;

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function createTraceExporter(env: Env): SpanExporter {
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf").trim();
  if (protocol === "http/json") {
    return new OtlpHttpJsonTraceExporter();
  }
  if (protocol !== "http/protobuf") {
    diag.warn(`Unsupported OTLP traces protocol "${protocol}", using http/protobuf`);
  }
  return new OtlpProtobufTraceExporter();
}

/**
 * Span processors in the order they must run: `SensitiveDataSpanProcessor`
 * first (it strips data in `onEnding`), then the batch exporter. We build the
 * list ourselves because passing any `spanProcessors` to `NodeSDK` replaces the
 * ones it would create from env — so this mirrors the env handling we rely on
 * (`OTEL_TRACES_EXPORTER=none`, OTLP protocol, `OTEL_BSP_*`).
 */
export function createSpanProcessors(env: Env): SpanProcessor[] {
  const exporters = (env.OTEL_TRACES_EXPORTER ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (exporters.length > 0 && exporters.every((name) => name === "none")) {
    return [];
  }
  return [
    new SensitiveDataSpanProcessor(),
    new BatchSpanProcessor({
      exporter: createTraceExporter(env),
      scheduledDelayMillis: nonNegativeNumber(env.OTEL_BSP_SCHEDULE_DELAY),
      exportTimeoutMillis: nonNegativeNumber(env.OTEL_BSP_EXPORT_TIMEOUT),
      maxQueueSize: nonNegativeNumber(env.OTEL_BSP_MAX_QUEUE_SIZE),
      maxExportBatchSize: nonNegativeNumber(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE),
    }),
  ];
}

/**
 * Explicit list (not `auto-instrumentations-node`, which turns on fs/dns/net
 * and dozens more). Configuration per the "Instrumentações" table of
 * docs/flows/observability/spec.md. None of them captures HTTP headers.
 */
export function createInstrumentations(): NodeSDKConfiguration["instrumentations"] {
  return [
    new HttpInstrumentation({
      // CORS preflights are noise: no handler runs and they double request counts.
      ignoreIncomingRequestHook: (request) => request.method === "OPTIONS",
      // The OTLP exporters' own POSTs would otherwise show up in http.client.request.duration.
      ignoreOutgoingRequestHook: (request) => OTLP_EXPORT_PATH.test(request.path ?? ""),
    }),
    new FastifyOtelInstrumentation({ registerOnInitialization: true, instrumentHooks: false }),
    new NestInstrumentation(),
    new UndiciInstrumentation(),
    // Command name only: Valkey keys hold session/seat/guest ids and values hold user ids.
    new IORedisInstrumentation({ dbStatementSerializer: (command) => command, requireParentSpan: true }),
    new SocketIoInstrumentation(),
    new PinoInstrumentation(),
    new RuntimeNodeInstrumentation(),
  ];
}

export function startOtelSdk(env: Env = process.env): NodeSDK {
  const sdk = new NodeSDK({
    instrumentations: createInstrumentations(),
    spanProcessors: createSpanProcessors(env),
  });
  sdk.start();
  return sdk;
}
