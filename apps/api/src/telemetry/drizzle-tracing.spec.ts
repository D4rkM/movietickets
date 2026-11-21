import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  DataPointType,
  HistogramMetricData,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { DrizzleQueryError } from "drizzle-orm/errors";
import {
  PostgresJsPreparedQuery,
  PostgresJsSession,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import {
  databaseNameFromUrl,
  DEFAULT_DRIZZLE_TRACING_TARGETS,
  DrizzleTracingTargets,
  errorTypeOf,
  instrumentDrizzle,
  parseSql,
} from "./drizzle-tracing";

/** Stand-ins with the same method shapes as drizzle-orm's postgres-js classes. */
function createFakeTargets() {
  class FakePreparedQuery {
    constructor(
      public queryString: string,
      private readonly result: unknown,
    ) {}

    async execute(): Promise<unknown> {
      if (this.result instanceof Error) throw this.result;
      return this.result;
    }
  }

  class FakeSession {
    async transaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
      return fn(new FakeTransaction());
    }
  }

  class FakeTransaction {
    async transaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
      return fn(new FakeTransaction());
    }
  }

  const targets: DrizzleTracingTargets = {
    preparedQuery: FakePreparedQuery.prototype,
    session: FakeSession.prototype,
    transaction: FakeTransaction.prototype,
  };
  return { FakePreparedQuery, FakeSession, targets };
}

describe("drizzle-tracing", () => {
  const contextManager = new AsyncLocalStorageContextManager();
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: TracerProvider;
  let metricExporter: InMemoryMetricExporter;
  let metricReader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    context.disable();
  });

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    meterProvider = new MeterProvider({ readers: [metricReader] });
  });

  afterEach(async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });

  function instrumentFakes(databaseUrl = "postgres://user:secret@db:5432/movietickets") {
    const fakes = createFakeTargets();
    instrumentDrizzle({ databaseUrl, tracerProvider, meterProvider, targets: fakes.targets, warn: jest.fn() });
    return fakes;
  }

  async function collectDurationHistogram(): Promise<HistogramMetricData | undefined> {
    await metricReader.forceFlush();
    const metrics = metricExporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    return metrics.find((m) => m.descriptor.name === "db.client.operation.duration") as HistogramMetricData | undefined;
  }

  describe("guard: drizzle-orm internals the patch depends on", () => {
    it("should still expose execute/transaction on the postgres-js classes", () => {
      // ARRANGE
      const prototypes = {
        execute: PostgresJsPreparedQuery.prototype.execute,
        sessionTransaction: PostgresJsSession.prototype.transaction,
        txTransaction: PostgresJsTransaction.prototype.transaction,
      };

      // ACT
      const types = Object.values(prototypes).map((fn) => typeof fn);

      // ASSERT
      expect(types).toEqual(["function", "function", "function"]);
      expect(DEFAULT_DRIZZLE_TRACING_TARGETS).toEqual({
        preparedQuery: PostgresJsPreparedQuery.prototype,
        session: PostgresJsSession.prototype,
        transaction: PostgresJsTransaction.prototype,
      });
    });

    it("should keep the parameterized SQL on PreparedQuery.queryString", () => {
      // ARRANGE
      const query = new PostgresJsPreparedQuery(
        {} as never,
        "select 1 where $1 = $1",
        [1],
        {} as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        false,
      );

      // ACT
      const queryString = (query as unknown as { queryString: unknown }).queryString;

      // ASSERT
      expect(queryString).toBe("select 1 where $1 = $1");
    });
  });

  describe("instrumentDrizzle", () => {
    it("should create a CLIENT span with db attributes and no parameter values", async () => {
      // ARRANGE
      const { FakePreparedQuery } = instrumentFakes();
      const query = new FakePreparedQuery('select "id", "status" from "bookings" where "bookings"."id" = $1', [{ id: 1 }]);

      // ACT
      const result = await query.execute();

      // ASSERT
      expect(result).toEqual([{ id: 1 }]);
      const [span] = spanExporter.getFinishedSpans();
      expect(span.name).toBe("SELECT bookings");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes).toEqual({
        "db.system.name": "postgresql",
        "db.namespace": "movietickets",
        "db.operation.name": "SELECT",
        "db.collection.name": "bookings",
        "db.query.text": 'select "id", "status" from "bookings" where "bookings"."id" = $1',
      });
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("should truncate db.query.text to 2 KB", async () => {
      // ARRANGE
      const { FakePreparedQuery } = instrumentFakes();
      const longSql = `select ${"x, ".repeat(2000)}1 from "seats"`;

      // ACT
      await new FakePreparedQuery(longSql, []).execute();

      // ASSERT
      const [span] = spanExporter.getFinishedSpans();
      expect((span.attributes["db.query.text"] as string).length).toBe(2048);
    });

    it("should mark the span as error with the SQLSTATE and rethrow, without the error message", async () => {
      // ARRANGE
      const { FakePreparedQuery } = instrumentFakes();
      const cause = Object.assign(new Error("duplicate key value"), { code: "23505" });
      const error = new DrizzleQueryError('insert into "booking_seats" ("seat_id") values ($1)', ["seat-secret"], cause);
      const query = new FakePreparedQuery('insert into "booking_seats" ("seat_id") values ($1)', error);

      // ACT
      const outcome = query.execute();

      // ASSERT
      await expect(outcome).rejects.toBe(error);
      const [span] = spanExporter.getFinishedSpans();
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.attributes["error.type"]).toBe("23505");
      expect(span.events).toEqual([]);
      expect(JSON.stringify(span.attributes)).not.toContain("seat-secret");
    });

    it("should record db.client.operation.duration with low-cardinality attributes", async () => {
      // ARRANGE
      const { FakePreparedQuery } = instrumentFakes();
      const failing = new FakePreparedQuery('update "seats" set "x" = $1', new Error("boom"));

      // ACT
      await new FakePreparedQuery('select * from "movies"', []).execute();
      await failing.execute().catch(() => undefined);

      // ASSERT
      const histogram = await collectDurationHistogram();
      expect(histogram?.descriptor.unit).toBe("s");
      expect(histogram?.dataPointType).toBe(DataPointType.HISTOGRAM);
      expect(histogram?.dataPoints.map((point) => point.attributes)).toEqual(
        expect.arrayContaining([
          { "db.system.name": "postgresql", "db.operation.name": "SELECT", "db.collection.name": "movies" },
          {
            "db.system.name": "postgresql",
            "db.operation.name": "UPDATE",
            "db.collection.name": "seats",
            "error.type": "Error",
          },
        ]),
      );
    });

    it("should group transaction and savepoint queries under db.transaction spans", async () => {
      // ARRANGE
      const { FakePreparedQuery, FakeSession } = instrumentFakes();
      const session = new FakeSession();

      // ACT
      await session.transaction(async (tx) => {
        await new FakePreparedQuery('select * from "bookings" for update', []).execute();
        await tx.transaction(async () => {
          await new FakePreparedQuery('insert into "booking_seats" values ($1)', []).execute();
        });
      });

      // ASSERT
      const spans = spanExporter.getFinishedSpans();
      const byName = (name: string) => spans.filter((span) => span.name === name);
      const transactions = byName("db.transaction");
      const outerTx = transactions.find((span) => span.parentSpanContext === undefined)!;
      const savepoint = transactions.find((span) => span !== outerTx)!;
      expect(transactions).toHaveLength(2);
      expect(outerTx.kind).toBe(SpanKind.INTERNAL);
      expect(savepoint.parentSpanContext?.spanId).toBe(outerTx.spanContext().spanId);
      expect(byName("SELECT bookings")[0].parentSpanContext?.spanId).toBe(outerTx.spanContext().spanId);
      expect(byName("INSERT booking_seats")[0].parentSpanContext?.spanId).toBe(savepoint.spanContext().spanId);
    });

    it("should mark the transaction span as error when the transaction rejects", async () => {
      // ARRANGE
      const { FakeSession } = instrumentFakes();

      // ACT
      const outcome = new FakeSession().transaction(async () => {
        throw new RangeError("rollback");
      });

      // ASSERT
      await expect(outcome).rejects.toThrow("rollback");
      const [span] = spanExporter.getFinishedSpans();
      expect(span.name).toBe("db.transaction");
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.attributes["error.type"]).toBe("RangeError");
    });

    it("should be idempotent: patching twice creates a single span per query", async () => {
      // ARRANGE
      const { FakePreparedQuery, targets } = createFakeTargets();
      instrumentDrizzle({ tracerProvider, meterProvider, targets });
      instrumentDrizzle({ tracerProvider, meterProvider, targets });

      // ACT
      await new FakePreparedQuery('delete from "sessions"', []).execute();

      // ASSERT
      expect(spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["DELETE sessions"]);
    });

    it("should warn and not patch anything when a drizzle internal is missing", async () => {
      // ARRANGE
      const { FakePreparedQuery, targets } = createFakeTargets();
      const warn = jest.fn();
      const broken: DrizzleTracingTargets = { ...targets, session: {} };

      // ACT
      const patched = instrumentDrizzle({ tracerProvider, meterProvider, targets: broken, warn });
      await new FakePreparedQuery('select 1 from "movies"', []).execute();

      // ASSERT
      expect(patched).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("PostgresJsSession.prototype.transaction"));
      expect(spanExporter.getFinishedSpans()).toEqual([]);
    });

    it("should emit a process warning by default when a drizzle internal is missing", () => {
      // ARRANGE
      const emitWarning = jest.spyOn(process, "emitWarning").mockImplementation(() => undefined);

      // ACT
      const patched = instrumentDrizzle({ targets: { preparedQuery: {}, session: {}, transaction: {} } });

      // ASSERT
      expect(patched).toBe(false);
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining("Drizzle tracing disabled"), {
        code: "MOVIETICKETS_DRIZZLE_TRACING",
      });
      emitWarning.mockRestore();
    });
  });

  describe("parseSql", () => {
    it.each([
      ['select "id", "name" from "movies" order by "movies"."title"', { operation: "SELECT", collection: "movies" }],
      [
        'select "bookings"."id" from "bookings" inner join "sessions" on "sessions"."id" = "bookings"."session_id" where "bookings"."status" = $1 for update',
        { operation: "SELECT", collection: "bookings" },
      ],
      ['insert into "booking_seats" ("booking_id", "seat_id") values ($1, $2)', { operation: "INSERT", collection: "booking_seats" }],
      ['update "payments" set "status" = $1 where "payments"."id" = $2 returning "id"', { operation: "UPDATE", collection: "payments" }],
      ['delete from "sessions" where "sessions"."id" = $1', { operation: "DELETE", collection: "sessions" }],
      ['  SELECT count(*) FROM public."seats"', { operation: "SELECT", collection: "seats" }],
      ['with "expired" as (select "id" from "bookings") update "bookings" set "status" = $1', { operation: "WITH", collection: "bookings" }],
      ["select 1", { operation: "SELECT" }],
      ["begin", { operation: "BEGIN" }],
      ["", {}],
    ])("should parse %s", (sql, expected) => {
      // ARRANGE
      const input = sql;

      // ACT
      const result = parseSql(input);

      // ASSERT
      expect(result).toEqual(expected);
    });
  });

  describe("databaseNameFromUrl", () => {
    it.each([
      ["postgres://movietickets:movietickets@localhost:5432/movietickets", "movietickets"],
      ["postgres://u:p@host/my%20db?sslmode=require", "my db"],
      ["postgres://u:p@host", undefined],
      ["not a url", undefined],
      [undefined, undefined],
    ])("should read the database name from %s", (url, expected) => {
      // ARRANGE
      const input = url;

      // ACT
      const result = databaseNameFromUrl(input);

      // ASSERT
      expect(result).toBe(expected);
    });
  });

  describe("errorTypeOf", () => {
    it.each([
      ["a SQLSTATE on the error", Object.assign(new Error("x"), { code: "40001" }), "40001"],
      ["a SQLSTATE on the cause", new DrizzleQueryError("q", [], Object.assign(new Error("x"), { code: "23503" })), "23503"],
      ["a non-SQLSTATE code on the cause", new DrizzleQueryError("q", [], Object.assign(new TypeError("x"), { code: "ECONNREFUSED" })), "TypeError"],
      ["a plain error", new RangeError("x"), "RangeError"],
      ["a non-error value", "boom", "_OTHER"],
    ])("should classify %s", (_scenario, err, expected) => {
      // ARRANGE
      const input: unknown = err;

      // ACT
      const result = errorTypeOf(input);

      // ASSERT
      expect(result).toBe(expected);
    });
  });
});
