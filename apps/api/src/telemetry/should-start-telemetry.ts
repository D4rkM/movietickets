/**
 * Env vars that point the OTLP exporters somewhere. The SDK only starts when at
 * least one of them is set to a non-blank value — no endpoint means telemetry
 * is off (unit/integration tests, CI, dev without the `observability` profile).
 */
export const OTLP_ENDPOINT_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

type Env = Record<string, string | undefined>;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Decides whether `instrumentation.ts` should boot the OpenTelemetry SDK.
 * Pure on purpose (takes the env as an argument) so it's unit-testable without
 * touching `process.env` or loading any SDK module.
 */
export function shouldStartTelemetry(env: Env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    return false;
  }
  return OTLP_ENDPOINT_ENV_VARS.some((name) => !isBlank(env[name]));
}

/**
 * Defaults applied only when telemetry is on and the var isn't already set
 * (blank counts as unset), so `apps/api/.env` / compose can still override any
 * of them. Sampler values follow decision D1 of the observability spec; the 15 s
 * metric interval keeps dashboards and 5-minute alerts responsive (SDK default
 * is 60 s).
 */
export const TELEMETRY_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  OTEL_SERVICE_NAME: "movietickets-api",
  OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
  OTEL_TRACES_SAMPLER_ARG: "1.0",
  OTEL_METRIC_EXPORT_INTERVAL: "15000",
};

/** Fills the missing `TELEMETRY_ENV_DEFAULTS` into `env` (mutates it). */
export function applyTelemetryEnvDefaults(env: Env): void {
  for (const [name, value] of Object.entries(TELEMETRY_ENV_DEFAULTS)) {
    if (isBlank(env[name])) {
      env[name] = value;
    }
  }
}
