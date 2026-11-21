import { OTLPTraceExporter as OtlpHttpJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OtlpProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { createSpanProcessors } from "./otel-sdk";
import { SensitiveDataSpanProcessor } from "./sensitive-data-span-processor";

/** Reads the exporter/delay the BatchSpanProcessor was built with (private fields). */
function batchInternals(processor: unknown): { exporter: unknown; scheduledDelayMillis: number } {
  const internals = processor as { _exporter: unknown; _scheduledDelayMillis: number };
  return { exporter: internals._exporter, scheduledDelayMillis: internals._scheduledDelayMillis };
}

describe("createSpanProcessors", () => {
  it("should put the sensitive-data processor before the batch exporter", () => {
    // ARRANGE
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" };

    // ACT
    const processors = createSpanProcessors(env);

    // ASSERT
    expect(processors).toHaveLength(2);
    expect(processors[0]).toBeInstanceOf(SensitiveDataSpanProcessor);
    expect(processors[1]).toBeInstanceOf(BatchSpanProcessor);
    expect(batchInternals(processors[1]).exporter).toBeInstanceOf(OtlpProtobufTraceExporter);
  });

  it.each([
    { env: { OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }, exporter: OtlpHttpJsonTraceExporter },
    { env: { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, exporter: OtlpHttpJsonTraceExporter },
    { env: { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }, exporter: OtlpProtobufTraceExporter },
    { env: { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, exporter: OtlpProtobufTraceExporter },
  ])("should pick the OTLP exporter for $env", ({ env, exporter }) => {
    // ARRANGE
    const input: Record<string, string | undefined> = env;

    // ACT
    const processors = createSpanProcessors(input);

    // ASSERT
    expect(batchInternals(processors[1]).exporter).toBeInstanceOf(exporter);
  });

  it("should honor OTEL_BSP_SCHEDULE_DELAY", () => {
    // ARRANGE
    const env = { OTEL_BSP_SCHEDULE_DELAY: "250" };

    // ACT
    const processors = createSpanProcessors(env);

    // ASSERT
    expect(batchInternals(processors[1]).scheduledDelayMillis).toBe(250);
  });

  it.each(["none", " none ", "none,none"])("should not export traces when OTEL_TRACES_EXPORTER=%s", (value) => {
    // ARRANGE
    const env = { OTEL_TRACES_EXPORTER: value };

    // ACT
    const processors = createSpanProcessors(env);

    // ASSERT
    expect(processors).toEqual([]);
  });
});
