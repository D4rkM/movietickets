import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import { ApiProcess, startApiProcess } from "./api-process";
import { CinemaFixture, createCinemaFixture } from "./cinema-fixture";
import { CollectedLogRecord, CollectedSpan, FakeOtlpCollector, OTLP_SPAN_KIND, waitFor } from "./otlp-collector";

/**
 * Steps for test/observability-smoke.e2e-spec.ts, named after the spec so the
 * test bodies read as the acceptance criteria.
 */

/** Short export intervals so telemetry reaches the fake collector within a test. */
export function fastExportEnv(collector: FakeOtlpCollector): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_SERVICE_NAME: "movietickets-api",
    OTEL_BSP_SCHEDULE_DELAY: "200",
    OTEL_BLRP_SCHEDULE_DELAY: "200",
    OTEL_METRIC_EXPORT_INTERVAL: "500",
  };
}

/** Export intervals far beyond the test, so only the SIGTERM flush can deliver data. */
export function slowExportEnv(collector: FakeOtlpCollector): Record<string, string> {
  return {
    ...fastExportEnv(collector),
    OTEL_BSP_SCHEDULE_DELAY: "120000",
    OTEL_BLRP_SCHEDULE_DELAY: "120000",
    OTEL_METRIC_EXPORT_INTERVAL: "120000",
  };
}

export async function startApiWithTelemetry(env: Record<string, string>): Promise<ApiProcess> {
  return startApiProcess({ env });
}

export async function startApiWithoutTelemetry(): Promise<ApiProcess> {
  return startApiProcess();
}

export interface SmokeDatabase {
  db: PostgresJsDatabase<typeof schema>;
  fixture: CinemaFixture;
  sessionId: string;
  seatId: string;
  close: () => Promise<void>;
}

export async function createSmokeCinema(label: string): Promise<SmokeDatabase> {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client, { schema });
  const fixture = await createCinemaFixture(db, label);
  const [seatId] = await fixture.addSeats(1);
  return {
    db,
    fixture,
    sessionId: fixture.sessionIds[0],
    seatId,
    close: async () => {
      await fixture.cleanup();
      await client.end();
    },
  };
}

export async function issueGuestToken(api: ApiProcess): Promise<string> {
  const response = await fetch(`${api.baseUrl}/auth/guest`, { method: "POST" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { guestToken: string };
  return body.guestToken;
}

export async function getSeatMap(api: ApiProcess, token: string, sessionId: string): Promise<Response> {
  return fetch(`${api.baseUrl}/sessions/${sessionId}/seats`, { headers: { authorization: `Bearer ${token}` } });
}

export async function holdSeat(api: ApiProcess, token: string, sessionId: string, seatId: string): Promise<Response> {
  return fetch(`${api.baseUrl}/sessions/${sessionId}/seats/${seatId}/hold`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function releaseAllHolds(api: ApiProcess, token: string, sessionId: string): Promise<void> {
  await fetch(`${api.baseUrl}/sessions/${sessionId}/holds`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function listMovies(api: ApiProcess): Promise<Response> {
  return fetch(`${api.baseUrl}/movies`);
}

/** A login with wrong credentials, carrying secrets in the header, cookie and body. */
export async function attemptLoginWithSecrets(
  api: ApiProcess,
  secrets: { authorization: string; cookie: string; email: string; password: string },
): Promise<Response> {
  return fetch(`${api.baseUrl}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: secrets.authorization,
      cookie: secrets.cookie,
    },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  });
}

export function waitForServerSpan(
  collector: FakeOtlpCollector,
  method: string,
  route: string,
  timeoutMs?: number,
): Promise<CollectedSpan> {
  return waitFor(
    `SERVER span ${method} ${route}`,
    () =>
      collector
        .spans()
        .find(
          (span) =>
            span.kind === OTLP_SPAN_KIND.SERVER &&
            span.attributes["http.request.method"] === method &&
            span.attributes["http.route"] === route,
        ),
    timeoutMs,
  );
}

export function spansOfTrace(collector: FakeOtlpCollector, traceId: string): CollectedSpan[] {
  return collector.spans().filter((span) => span.traceId === traceId);
}

/** True when `span` descends from `ancestor` through the spans collected for its trace. */
export function isDescendantOf(collector: FakeOtlpCollector, span: CollectedSpan, ancestor: CollectedSpan): boolean {
  const byId = new Map(spansOfTrace(collector, span.traceId).map((s) => [s.spanId, s]));
  let parentId = span.parentSpanId;
  while (parentId) {
    if (parentId === ancestor.spanId) return true;
    parentId = byId.get(parentId)?.parentSpanId;
  }
  return false;
}

export function waitForLogOfTrace(collector: FakeOtlpCollector, traceId: string): Promise<CollectedLogRecord> {
  return waitFor(`a log record of trace ${traceId}`, () =>
    collector.logRecords().find((record) => record.traceId === traceId),
  );
}
