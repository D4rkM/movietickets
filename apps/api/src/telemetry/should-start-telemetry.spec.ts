import { applyTelemetryEnvDefaults, shouldStartTelemetry } from "./should-start-telemetry";

describe("shouldStartTelemetry", () => {
  it.each([
    { scenario: "no OTEL vars at all", env: {}, expected: false },
    { scenario: "an empty endpoint", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "" }, expected: false },
    { scenario: "a whitespace-only endpoint", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "   " }, expected: false },
    { scenario: "a base endpoint", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }, expected: true },
    {
      scenario: "only the traces endpoint",
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces" },
      expected: true,
    },
    {
      scenario: "only the metrics endpoint",
      env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://localhost:4318/v1/metrics" },
      expected: true,
    },
    {
      scenario: "only the logs endpoint",
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs" },
      expected: true,
    },
    {
      scenario: "an endpoint with OTEL_SDK_DISABLED=true",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "true" },
      expected: false,
    },
    {
      scenario: "an endpoint with OTEL_SDK_DISABLED=TRUE (case-insensitive)",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: " TRUE " },
      expected: false,
    },
    {
      scenario: "an endpoint with OTEL_SDK_DISABLED=false",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "false" },
      expected: true,
    },
    {
      scenario: "an endpoint with an empty OTEL_SDK_DISABLED",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SDK_DISABLED: "" },
      expected: true,
    },
  ])("should return $expected given $scenario", ({ env, expected }) => {
    // ARRANGE
    const input: Record<string, string | undefined> = { ...env };

    // ACT
    const result = shouldStartTelemetry(input);

    // ASSERT
    expect(result).toBe(expected);
  });
});

describe("applyTelemetryEnvDefaults", () => {
  it("should fill service name, sampler and metric interval when unset", () => {
    // ARRANGE
    const env: Record<string, string | undefined> = { OTEL_SERVICE_NAME: "" };

    // ACT
    applyTelemetryEnvDefaults(env);

    // ASSERT
    expect(env).toEqual({
      OTEL_SERVICE_NAME: "movietickets-api",
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "1.0",
      OTEL_METRIC_EXPORT_INTERVAL: "15000",
    });
  });

  it("should keep values already present in the environment", () => {
    // ARRANGE
    const env: Record<string, string | undefined> = {
      OTEL_TRACES_SAMPLER_ARG: "0.1",
      OTEL_METRIC_EXPORT_INTERVAL: "500",
    };

    // ACT
    applyTelemetryEnvDefaults(env);

    // ASSERT
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe("0.1");
    expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("500");
  });
});
