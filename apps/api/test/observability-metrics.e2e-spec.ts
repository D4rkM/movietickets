import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE, DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { expectedDbNamespace, exportedContent, startTestTelemetry, TestTelemetry } from "./helpers/telemetry";

/**
 * Postgres tracing (Drizzle patch) against the real database, with in-memory
 * OpenTelemetry exporters. Business metrics (card 2.3) join this file later.
 */
describe("Observabilidade: métricas e spans em memória (e2e)", () => {
  let telemetry: TestTelemetry;
  let moduleRef: TestingModule;
  let db: PostgresJsDatabase<typeof schema>;
  let movieId: string;
  const movieTitle = `Observability Movie ${Date.now()}`;

  beforeAll(async () => {
    telemetry = startTestTelemetry();
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule],
    }).compile();
    await moduleRef.init();
    db = moduleRef.get(DRIZZLE);
    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: movieTitle, durationMinutes: 100 })
      .returning({ id: schema.movies.id });
  });

  beforeEach(() => {
    telemetry.reset();
  });

  afterAll(async () => {
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
    await moduleRef.close();
    await telemetry.shutdown();
  });

  it("AC4: deve gerar span de query do Postgres sem os valores dos parâmetros", async () => {
    // GIVEN um filme cadastrado

    // WHEN uma request busca o filme pelo título
    const { traceId, requestSpanId } = await telemetry.insideRequestSpan(() =>
      db.select().from(schema.movies).where(eq(schema.movies.title, movieTitle)),
    );

    // THEN a query vira um span CLIENT filho da request, com o SQL parametrizado e sem o título
    const [query] = telemetry.spansOfTrace(traceId).filter((span) => span.kind === SpanKind.CLIENT);
    expect(query.name).toBe("SELECT movies");
    expect(query.parentSpanContext?.spanId).toBe(requestSpanId);
    expect(query.attributes).toMatchObject({
      "db.system.name": "postgresql",
      "db.namespace": expectedDbNamespace(),
      "db.operation.name": "SELECT",
      "db.collection.name": "movies",
    });
    expect(query.attributes["db.query.text"]).toEqual(expect.stringContaining('"movies"."title" = $1'));
    expect(exportedContent(query)).not.toContain(movieTitle);
  });

  it("AC4: deve marcar o span com erro e error.type quando a query falha", async () => {
    // GIVEN um id que não é UUID válido
    const invalidId = "not-a-uuid-observability";

    // WHEN uma request consulta uma sessão com esse id e o Postgres recusa
    const { traceId } = await telemetry.insideRequestSpan(() =>
      db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, invalidId))
        .catch((err: unknown) => err),
    );

    // THEN o span da query sai com status de erro e o SQLSTATE, sem o valor do parâmetro
    const [query] = telemetry.spansOfTrace(traceId).filter((span) => span.kind === SpanKind.CLIENT);
    expect(query.status.code).toBe(SpanStatusCode.ERROR);
    expect(query.attributes["error.type"]).toBe("22P02");
    expect(exportedContent(query)).not.toContain(invalidId);
  });

  it("AC4: deve agrupar as queries de uma transação sob o span db.transaction", async () => {
    // GIVEN um filme cadastrado

    // WHEN uma request lê o filme duas vezes dentro de uma transação
    const { traceId, requestSpanId } = await telemetry.insideRequestSpan(() =>
      db.transaction(async (tx) => {
        await tx.select().from(schema.movies).where(eq(schema.movies.id, movieId));
        await tx.select().from(schema.movies).where(eq(schema.movies.id, movieId)).for("update");
      }),
    );

    // THEN as duas queries ficam sob o span db.transaction, que é filho da request
    const spans = telemetry.spansOfTrace(traceId);
    const transaction = spans.find((span) => span.name === "db.transaction")!;
    expect(transaction.parentSpanContext?.spanId).toBe(requestSpanId);
    const queries = spans.filter((span) => span.name === "SELECT movies");
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    }
  });

  it("AC4: deve registrar db.client.operation.duration para cada query", async () => {
    // GIVEN um filme cadastrado

    // WHEN uma request busca o filme
    await telemetry.insideRequestSpan(() => db.select().from(schema.movies).where(eq(schema.movies.id, movieId)));

    // THEN o histograma de duração tem pontos com operação e tabela, sem valores de parâmetro
    const points = await telemetry.dataPoints("db.client.operation.duration");
    const selectMovies = points.find(
      (point) => point.attributes["db.operation.name"] === "SELECT" && point.attributes["db.collection.name"] === "movies",
    );
    expect(selectMovies?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.collection.name": "movies",
    });
    expect(selectMovies?.value.count).toBeGreaterThan(0);
  });
});
