/**
 * OpenTelemetry bootstrap. Loaded with `node --require ./dist/instrumentation.js`
 * BEFORE the app (see Dockerfile / `start:dev` / `start:prod`), so the
 * instrumentations can hook `http`, fastify, ioredis, pino etc. before Nest
 * requires them. Off unless an OTLP endpoint is configured — see
 * docs/flows/observability/spec.md ("Bootstrap").
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { applyTelemetryEnvDefaults, shouldStartTelemetry } from "./telemetry/should-start-telemetry";

// ConfigModule hasn't run yet, so read apps/api/.env here (never overriding
// what already came from the real environment, e.g. compose `environment`).
loadDotenv({ path: resolve(__dirname, "../.env"), quiet: true });

if (shouldStartTelemetry(process.env)) {
  applyTelemetryEnvDefaults(process.env);

  // Required lazily so that, with telemetry off, no SDK module is loaded at all.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { startOtelSdk } = require("./telemetry/otel-sdk") as typeof import("./telemetry/otel-sdk");
  const { instrumentDrizzle } = require("./telemetry/drizzle-tracing") as typeof import("./telemetry/drizzle-tracing");
  const { shutdownOnSignal } = require("./telemetry/shutdown-on-signal") as typeof import("./telemetry/shutdown-on-signal");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sdk = startOtelSdk(process.env);
  instrumentDrizzle({ databaseUrl: process.env.DATABASE_URL });
  shutdownOnSignal(() => sdk.shutdown());
}
