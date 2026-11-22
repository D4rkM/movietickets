import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE, DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import {
  connectToSeating,
  mercadoPagoAnswersPayment,
  recordedBusinessAttributeValues,
  startAppWithBusinessMetrics,
  unexpectedMetricAttributes,
} from "./helpers/business-metrics";
import { CinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import { clearSessionHolds, holdSeatAs, holdSeatsAs, obtainGuestIdentity, releaseSeatAs } from "./helpers/guest-flow";
import { GuestFlowApp } from "./helpers/guest-flow-app";
import {
  bookSeatsAsOrFail,
  confirmAs,
  deletePaymentsOfSessions,
  deliverPaymentWebhook,
  MercadoPagoMocks,
  mercadoPagoMocks,
  payBookingAs,
} from "./helpers/pending-booking";
import {
  cancelAs,
  createPaidBooking,
  createRefundCinemaFixture,
  mercadoPagoAnswersRefund,
  signUserToken,
} from "./helpers/refund";
import {
  expectedDbNamespace,
  exportedContent,
  startTestTelemetry,
  TestTelemetry,
  watchMetric,
} from "./helpers/telemetry";

/**
 * Postgres tracing (Drizzle patch) and business metrics (`movietickets.*`)
 * against the real database/Valkey, with in-memory OpenTelemetry exporters.
 * Spec: docs/flows/observability/spec.md (AC4, AC8, AC9, AC11). AC10 (sweeper)
 * lives in pending-booking-sweeper.e2e-spec.ts: the sweeper is global to the
 * database, so it only runs from one test file to avoid cross-file races.
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

describe("Observabilidade: métricas de negócio nos fluxos reais (e2e)", () => {
  let telemetry: TestTelemetry;
  let ctx: GuestFlowApp;
  let mp: MercadoPagoMocks;
  let fixture: CinemaFixture;
  let sessionId: string;
  let owner: TestUser;
  let otherUser: TestUser;
  let ownerToken: string;
  let otherUserToken: string;

  beforeAll(async () => {
    telemetry = startTestTelemetry();
    ctx = await startAppWithBusinessMetrics(telemetry);
    mp = mercadoPagoMocks(ctx.app);
    fixture = await createRefundCinemaFixture(ctx.db, `Business Metrics E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    [owner, otherUser] = await Promise.all([
      createUserWithPassword(ctx.db, "metrics-owner"),
      createUserWithPassword(ctx.db, "metrics-other"),
    ]);
    [ownerToken, otherUserToken] = [signUserToken(ctx, owner), signUserToken(ctx, otherUser)];
  });

  afterEach(async () => {
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [owner, otherUser]);
    await ctx.close();
    await telemetry.shutdown();
  });

  it("AC8: deve contar um hold criado de convidado ao segurar assento com token de convidado", async () => {
    // GIVEN um convidado e um assento livre
    const guest = await obtainGuestIdentity(ctx.app, ctx.jwtService);
    const [seatId] = await fixture.addSeats(1);
    const guestHolds = await watchMetric(telemetry, "movietickets.seat_hold.created", { "holder.kind": "guest" });
    const heldBroadcasts = await watchMetric(telemetry, "movietickets.seating.broadcasts", { "seat.status": "held" });

    // WHEN o convidado segura o assento
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // THEN conta um hold criado de convidado e um broadcast "held"
    expect(await guestHolds.increase()).toBe(1);
    expect(await heldBroadcasts.increase()).toBe(1);
  });

  it("AC8: deve contar a recusa de hold de assento segurado por outro usuário sem contar hold criado", async () => {
    // GIVEN um assento segurado por outro usuário
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, otherUserToken, sessionId, [seatId]);
    const rejected = await watchMetric(telemetry, "movietickets.seat_hold.rejected", { reason: "held_by_other" });
    const created = await watchMetric(telemetry, "movietickets.seat_hold.created");

    // WHEN o dono tenta segurar o mesmo assento
    const response = await holdSeatAs(ctx.app, ownerToken, sessionId, seatId);

    // THEN a recusa é contada com o motivo e nenhum hold novo aparece
    expect(response.statusCode).toBe(409);
    expect(await rejected.increase()).toBe(1);
    expect(await created.increase()).toBe(0);
  });

  it("AC8: deve contar o hold liberado manualmente ao soltar o assento", async () => {
    // GIVEN um assento segurado pelo dono
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, ownerToken, sessionId, [seatId]);
    const manualReleases = await watchMetric(telemetry, "movietickets.seat_hold.released", { reason: "manual" });

    // WHEN o dono solta o assento
    await releaseSeatAs(ctx.app, ownerToken, sessionId, seatId);

    // THEN conta uma liberação manual
    expect(await manualReleases.increase()).toBe(1);
  });

  it("AC8: deve contar a reserva criada com a quantidade de assentos e liberar os holds como booked", async () => {
    // GIVEN dois assentos segurados pelo dono
    const seatIds = await fixture.addSeats(2);
    await holdSeatsAs(ctx.app, ownerToken, sessionId, seatIds);
    const created = await watchMetric(telemetry, "movietickets.booking.created");
    const bookingsInSeatsHistogram = await watchMetric(telemetry, "movietickets.booking.seats");
    const seatsInSeatsHistogram = await watchMetric(telemetry, "movietickets.booking.seats", {}, "sum");
    const releasedAsBooked = await watchMetric(telemetry, "movietickets.seat_hold.released", { reason: "booked" });

    // WHEN o dono reserva os dois assentos
    await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, seatIds);

    // THEN conta uma reserva, registra o tamanho dela e os dois holds viram booked
    expect(await created.increase()).toBe(1);
    expect(await bookingsInSeatsHistogram.increase()).toBe(1);
    expect(await seatsInSeatsHistogram.increase()).toBe(2);
    expect(await releasedAsBooked.increase()).toBe(2);
  });

  it("AC8: deve contar uma reserva confirmada com origem mock ao confirmar pelo endpoint de teste", async () => {
    // GIVEN uma reserva pendente do dono
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);
    const mockConfirmations = await watchMetric(telemetry, "movietickets.booking.confirmed", {
      "confirmation.source": "mock",
    });
    const confirmationEmails = await watchMetric(telemetry, "movietickets.notification.email");

    // WHEN o dono confirma pelo endpoint de teste
    const response = await confirmAs(ctx.app, ownerToken, bookingId);

    // THEN conta uma confirmação mock e uma tentativa de e-mail de confirmação
    expect(response.statusCode).toBe(200);
    expect(await mockConfirmations.increase()).toBe(1);
    expect(await confirmationEmails.increase()).toBe(1);
  });

  it("AC8: deve contar tentativa criada, pagamento aprovado síncrono e confirmação com origem payment_sync", async () => {
    // GIVEN uma reserva pendente e o Mercado Pago aprovando na hora
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);
    mercadoPagoAnswersPayment(mp, "approved");
    const attempts = await watchMetric(telemetry, "movietickets.payment.attempt.created");
    const approvedSync = await watchMetric(telemetry, "movietickets.payment.status_changed", {
      "payment.status": "approved",
      "payment.source": "sync",
    });
    const paidConfirmations = await watchMetric(telemetry, "movietickets.booking.confirmed", {
      "confirmation.source": "payment_sync",
    });

    // WHEN o dono paga a reserva
    const response = await payBookingAs(ctx.app, ownerToken, bookingId);

    // THEN conta a tentativa, o status aprovado vindo da resposta síncrona e a confirmação
    expect(response.statusCode).toBe(200);
    expect(await attempts.increase()).toBe(1);
    expect(await approvedSync.increase()).toBe(1);
    expect(await paidConfirmations.increase()).toBe(1);
  });

  it("AC9: deve registrar status desconhecido do Mercado Pago como other", async () => {
    // GIVEN uma reserva pendente
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);
    const otherStatus = await watchMetric(telemetry, "movietickets.payment.status_changed", {
      "payment.status": "other",
      "payment.source": "webhook",
    });

    // WHEN o webhook traz um status que o Mercado Pago acabou de inventar
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "brand_new_status");

    // THEN a mudança é contada como other, sem o status cru virar atributo
    expect(await otherStatus.increase()).toBe(1);
    expect(await recordedBusinessAttributeValues(telemetry)).not.toContain("brand_new_status");
  });

  it("AC9: não deve gravar atributo fora da allowlist nem ids em nenhuma métrica de negócio", async () => {
    // GIVEN os fluxos de hold, reserva, pagamento e estorno já exercitados neste arquivo
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);

    // WHEN mais uma reserva é paga pelo webhook
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved");

    // THEN nenhuma métrica movietickets.* tem chave fora da tabela nem id de usuário, reserva ou assento
    expect(await unexpectedMetricAttributes(telemetry)).toEqual([]);
    const recordedValues = await recordedBusinessAttributeValues(telemetry);
    for (const id of [owner.id, otherUser.id, bookingId, seatId, sessionId]) {
      expect(recordedValues).not.toContain(id);
    }
  });

  it("AC8: deve contar o estorno solicitado, aprovado e a reserva cancelada ao cancelar reserva paga", async () => {
    // GIVEN uma reserva confirmada e paga, e o Mercado Pago aprovando o estorno
    const seatIds = await fixture.addSeats(1);
    const paid = await createPaidBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
    mercadoPagoAnswersRefund(mp, "approved");
    const requested = await watchMetric(telemetry, "movietickets.refund.requested");
    const approved = await watchMetric(telemetry, "movietickets.refund.status_changed", { "refund.status": "approved" });
    const cancelled = await watchMetric(telemetry, "movietickets.booking.cancelled");

    // WHEN o dono cancela a reserva
    const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

    // THEN conta o pedido de estorno, a aprovação e o cancelamento
    expect(response.statusCode).toBe(200);
    expect(await requested.increase()).toBe(1);
    expect(await approved.increase()).toBe(1);
    expect(await cancelled.increase()).toBe(1);
  });

  it("AC11: deve aumentar e diminuir as conexões ativas do WebSocket ao conectar e desconectar", async () => {
    // GIVEN o gauge de conexões ativas antes da conexão
    const connections = await watchMetric(telemetry, "movietickets.seating.ws.connections");

    // WHEN o dono conecta no /seating com um token válido
    const connection = await connectToSeating(ctx.baseUrl, ownerToken);

    // THEN a conexão é aceita e o gauge sobe 1
    expect(connection.accepted).toBe(true);
    expect(await connections.settlesAt(1)).toBe(1);

    // WHEN a conexão cai
    await connection.close();

    // THEN o gauge volta ao valor de antes
    expect(await connections.settlesAt(0)).toBe(0);
  });

  it("AC11: deve contar conexão recusada sem token sem mexer nas conexões ativas", async () => {
    // GIVEN o gauge de conexões ativas e as recusas por falta de token
    const connections = await watchMetric(telemetry, "movietickets.seating.ws.connections");
    const missingToken = await watchMetric(telemetry, "movietickets.seating.ws.rejected", { reason: "missing_token" });

    // WHEN alguém conecta no /seating sem token
    const connection = await connectToSeating(ctx.baseUrl);
    await connection.close();

    // THEN a recusa é contada e o gauge não muda
    expect(connection.accepted).toBe(false);
    expect(await missingToken.settlesAt(1)).toBe(1);
    expect(await connections.increase()).toBe(0);
  });

  it("AC11: deve contar conexão recusada com token inválido sem mexer nas conexões ativas", async () => {
    // GIVEN o gauge de conexões ativas e as recusas por token inválido
    const connections = await watchMetric(telemetry, "movietickets.seating.ws.connections");
    const invalidToken = await watchMetric(telemetry, "movietickets.seating.ws.rejected", { reason: "invalid_token" });

    // WHEN alguém conecta no /seating com um token adulterado
    const connection = await connectToSeating(ctx.baseUrl, `${ownerToken}tampered`);
    await connection.close();

    // THEN a recusa é contada e o gauge não muda
    expect(connection.accepted).toBe(false);
    expect(await invalidToken.settlesAt(1)).toBe(1);
    expect(await connections.increase()).toBe(0);
  });
});
