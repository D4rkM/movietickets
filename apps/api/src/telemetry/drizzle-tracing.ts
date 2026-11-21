import {
  Attributes,
  Histogram,
  MeterProvider,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  TracerProvider,
} from "@opentelemetry/api";
import {
  PostgresJsPreparedQuery,
  PostgresJsSession,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

/**
 * Manual Postgres tracing for Drizzle over postgres.js (there's no official
 * OTel instrumentation for postgres.js — see "Postgres: abordagem pra
 * postgres.js" in docs/flows/observability/spec.md, option A).
 *
 * Wraps two Drizzle internals:
 * - `PostgresJsPreparedQuery.prototype.execute`: every query-builder query
 *   goes through it and it resolves with the full result, so the span/metric
 *   measure the real round-trip.
 * - `PostgresJsSession/PostgresJsTransaction.prototype.transaction`: a
 *   `db.transaction` span groups the queries of a transaction (or savepoint).
 *
 * Parameter values are never recorded — only the parameterized SQL text.
 */

const INSTRUMENTATION_NAME = "movietickets-drizzle";
const PATCHED = Symbol.for("movietickets.drizzle-tracing.patched");
const MAX_QUERY_TEXT_LENGTH = 2048;
const SQLSTATE = /^[0-9A-Z]{5}$/;

type AnyFunction = (...args: unknown[]) => unknown;
type Patchable = Record<string | symbol, unknown>;

/** Prototypes the patch is applied to; overridable so unit tests can use fakes. */
export interface DrizzleTracingTargets {
  preparedQuery: object;
  session: object;
  transaction: object;
}

export interface DrizzleTracingOptions {
  /** `DATABASE_URL`, used only to read the database name (`db.namespace`). */
  databaseUrl?: string;
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  targets?: DrizzleTracingTargets;
  /** Called instead of throwing when a Drizzle internal is missing. */
  warn?: (message: string) => void;
}

export const DEFAULT_DRIZZLE_TRACING_TARGETS: DrizzleTracingTargets = {
  preparedQuery: PostgresJsPreparedQuery.prototype,
  session: PostgresJsSession.prototype,
  transaction: PostgresJsTransaction.prototype,
};

export interface ParsedSql {
  operation?: string;
  collection?: string;
}

const IDENTIFIER = String.raw`((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)`;
const COLLECTION_PATTERNS: Record<string, RegExp> = {
  SELECT: new RegExp(String.raw`\bfrom\s+${IDENTIFIER}`, "i"),
  DELETE: new RegExp(String.raw`\bfrom\s+${IDENTIFIER}`, "i"),
  WITH: new RegExp(String.raw`\bfrom\s+${IDENTIFIER}`, "i"),
  INSERT: new RegExp(String.raw`\binto\s+${IDENTIFIER}`, "i"),
  UPDATE: new RegExp(String.raw`^\s*update\s+(?:only\s+)?${IDENTIFIER}`, "i"),
};

/**
 * Best-effort extraction of `db.operation.name` (first SQL keyword) and
 * `db.collection.name` (first table after from/into/update). A simple regex
 * is enough for the SQL Drizzle generates; anything else just yields no table.
 */
export function parseSql(queryText: string): ParsedSql {
  const operation = /^[\s(]*([a-z]+)/i.exec(queryText)?.[1]?.toUpperCase();
  if (!operation) {
    return {};
  }
  const match = COLLECTION_PATTERNS[operation]?.exec(queryText);
  if (!match) {
    return { operation };
  }
  const lastSegment = match[1].split(".").pop()!.trim();
  return { operation, collection: lastSegment.replace(/^"|"$/g, "") };
}

/** Database name from a connection string, never user/password/host. */
export function databaseNameFromUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) {
    return undefined;
  }
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
    return name || undefined;
  } catch {
    return undefined;
  }
}

function sqlState(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  const code = (value as { code: unknown }).code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
}

/**
 * `error.type` for a failed query: the Postgres SQLSTATE when there is one
 * (Drizzle wraps the driver error in `DrizzleQueryError`, so it's usually on
 * `.cause`), else the class name of the underlying error.
 */
export function errorTypeOf(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  const code = sqlState(err) ?? sqlState(cause);
  if (code) {
    return code;
  }
  const root = cause instanceof Error ? cause : err;
  return root instanceof Error ? root.constructor.name || "Error" : "_OTHER";
}

function isPatched(target: object): boolean {
  return (target as Patchable)[PATCHED] === true;
}

function markPatched(target: object): void {
  Object.defineProperty(target, PATCHED, { value: true, enumerable: false, configurable: true });
}

function hasMethod(target: object, method: string): boolean {
  return typeof (target as Patchable)[method] === "function";
}

/**
 * Applies the tracing patch. Idempotent (each prototype is marked) and never
 * throws: if a Drizzle internal is missing (e.g. after an upgrade), it warns
 * and leaves the API running without database spans. Returns whether the
 * prototypes are patched after the call.
 */
export function instrumentDrizzle(options: DrizzleTracingOptions = {}): boolean {
  const targets = options.targets ?? DEFAULT_DRIZZLE_TRACING_TARGETS;
  const warn = options.warn ?? ((message: string) => process.emitWarning(message, { code: "MOVIETICKETS_DRIZZLE_TRACING" }));

  const missing = [
    hasMethod(targets.preparedQuery, "execute") ? undefined : "PostgresJsPreparedQuery.prototype.execute",
    hasMethod(targets.session, "transaction") ? undefined : "PostgresJsSession.prototype.transaction",
    hasMethod(targets.transaction, "transaction") ? undefined : "PostgresJsTransaction.prototype.transaction",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    warn(`Drizzle tracing disabled: ${missing.join(", ")} not found (drizzle-orm internals changed?)`);
    return false;
  }

  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(INSTRUMENTATION_NAME);
  // Created here, after the SDK registered the global MeterProvider: the
  // metrics API has no proxy, so a meter taken earlier would be a no-op forever.
  const duration = (options.meterProvider ?? metrics.getMeterProvider())
    .getMeter(INSTRUMENTATION_NAME)
    .createHistogram("db.client.operation.duration", {
      description: "Duration of database client operations.",
      unit: "s",
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] },
    });
  const namespace = databaseNameFromUrl(options.databaseUrl);

  if (!isPatched(targets.preparedQuery)) {
    wrapExecute(targets.preparedQuery, tracer, duration, namespace);
    markPatched(targets.preparedQuery);
  }
  for (const target of [targets.session, targets.transaction]) {
    if (!isPatched(target)) {
      wrapTransaction(target, tracer, namespace);
      markPatched(target);
    }
  }
  return true;
}

function wrapExecute(
  target: object,
  tracer: ReturnType<TracerProvider["getTracer"]>,
  duration: Histogram,
  namespace: string | undefined,
): void {
  const patchable = target as Patchable;
  const original = patchable.execute as AnyFunction;

  patchable.execute = function tracedExecute(this: { queryString?: unknown }, ...args: unknown[]) {
    const queryText = typeof this.queryString === "string" ? this.queryString : "";
    const { operation, collection } = parseSql(queryText);

    const metricAttributes: Attributes = { "db.system.name": "postgresql" };
    if (operation) metricAttributes["db.operation.name"] = operation;
    if (collection) metricAttributes["db.collection.name"] = collection;

    const spanAttributes: Attributes = {
      ...metricAttributes,
      "db.query.text": queryText.slice(0, MAX_QUERY_TEXT_LENGTH),
    };
    if (namespace) spanAttributes["db.namespace"] = namespace;

    const spanName = [operation, collection].filter(Boolean).join(" ") || "postgresql";
    const startedAt = performance.now();

    return tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.CLIENT, attributes: spanAttributes },
      async (span) => {
        try {
          return await original.apply(this, args);
        } catch (err) {
          // Status without the error message on purpose: DrizzleQueryError's
          // message embeds the query params.
          const errorType = errorTypeOf(err);
          metricAttributes["error.type"] = errorType;
          span.setAttribute("error.type", errorType);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
          duration.record((performance.now() - startedAt) / 1000, metricAttributes);
        }
      },
    );
  };
}

function wrapTransaction(
  target: object,
  tracer: ReturnType<TracerProvider["getTracer"]>,
  namespace: string | undefined,
): void {
  const patchable = target as Patchable;
  const original = patchable.transaction as AnyFunction;

  patchable.transaction = function tracedTransaction(this: unknown, ...args: unknown[]) {
    const attributes: Attributes = { "db.system.name": "postgresql" };
    if (namespace) attributes["db.namespace"] = namespace;

    return tracer.startActiveSpan("db.transaction", { kind: SpanKind.INTERNAL, attributes }, async (span) => {
      try {
        return await original.apply(this, args);
      } catch (err) {
        span.setAttribute("error.type", errorTypeOf(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
