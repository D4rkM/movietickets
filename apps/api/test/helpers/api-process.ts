import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Runs the COMPILED API (`dist/`) as a child process, exactly like the
 * container does: `node --require ./dist/instrumentation.js dist/main.js`.
 * Needed because the OTel auto-instrumentations hook `require`, which doesn't
 * work reliably inside Jest's module registry (U3 in the observability spec).
 * Requires `pnpm --filter api build` beforehand.
 */

const API_ROOT = join(__dirname, "..", "..");
const ENTRY = join(API_ROOT, "dist", "main.js");
const INSTRUMENTATION = join(API_ROOT, "dist", "instrumentation.js");

export interface ApiProcess {
  baseUrl: string;
  /** Everything the process wrote to stdout/stderr so far (for failure messages). */
  output: () => string;
  /** Sends `signal` and resolves once the process exited, with how long it took. */
  stop: (signal?: NodeJS.Signals) => Promise<{ elapsedMs: number; code: number | null; signal: NodeJS.Signals | null }>;
}

export interface StartApiProcessOptions {
  /** OTEL_* (and any other) vars for the child. OTEL_* from the parent env never leak in. */
  env?: Record<string, string>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function baseEnv(port: number): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("OTEL_"),
    ),
  );
  return {
    ...inherited,
    // Every endpoint var is set (blank) so a developer's apps/api/.env, which
    // instrumentation.ts loads without overriding, can't switch telemetry on.
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
    NODE_ENV: "production",
    PORT: String(port),
    LOG_LEVEL: "info",
    JWT_SECRET: process.env.JWT_SECRET ?? "test-secret",
    MERCADOPAGO_ACCESS_TOKEN: "TEST-observability-smoke",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    VALKEY_URL: process.env.VALKEY_URL ?? "",
  };
}

async function waitUntilReady(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited early (code ${child.exitCode}):\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/movies`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API did not become ready in 20 s:\n${output()}`);
}

export async function startApiProcess(options: StartApiProcessOptions = {}): Promise<ApiProcess> {
  if (!existsSync(ENTRY) || !existsSync(INSTRUMENTATION)) {
    throw new Error("dist/ not found: run `pnpm --filter api build` before the observability smoke test");
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--require", INSTRUMENTATION, ENTRY], {
    cwd: API_ROOT,
    env: { ...baseEnv(port), ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let captured = "";
  child.stdout!.on("data", (chunk: Buffer) => (captured += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (captured += chunk.toString()));
  const output = () => captured;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  try {
    await waitUntilReady(baseUrl, child, output);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }

  return {
    baseUrl,
    output,
    stop: async (signal = "SIGTERM") => {
      const startedAt = Date.now();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
      const result = await exited;
      return { ...result, elapsedMs: Date.now() - startedAt };
    },
  };
}
