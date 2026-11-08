import { CinemaFixture, createCinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import { clearSessionHolds, holdSeatAs, seatStatusSeenBy, watchSessionAs } from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";
import { countMailpitMessages, findMailpitMessage } from "./helpers/mailpit";
import {
  backdateCreationOnly,
  bookSeatsAs,
  bookSeatsAsOrFail,
  captureWarnings,
  checkoutAs,
  confirmAs,
  deadlineWindowSeconds,
  deletePaymentsOfSessions,
  deliverPaymentWebhook,
  expireDeadlineOf,
  insertBooking,
  MercadoPagoMocks,
  mercadoPagoMocks,
  readBooking,
  readPayment,
  recordPayment,
  runExpiresAtBackfillFor,
  seatIdsOf,
  settle,
} from "./helpers/pending-booking";

// Spec: docs/flows/pending-booking-expiry/spec.md (lazy expiry, payments, checkout/confirm)
describe("Expiração de reserva pendente (e2e)", () => {
  let ctx: GuestFlowApp;
  let mp: MercadoPagoMocks;
  let fixture: CinemaFixture;
  let sessionId: string;
  let owner: TestUser;
  let buyer: TestUser;
  let otherBuyer: TestUser;
  let ownerToken: string;
  let buyerToken: string;
  let otherBuyerToken: string;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    mp = mercadoPagoMocks(ctx.app);
    fixture = await createCinemaFixture(ctx.db, `Pending Expiry E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    [owner, buyer, otherBuyer] = await Promise.all([
      createUserWithPassword(ctx.db, "expiry-owner"),
      createUserWithPassword(ctx.db, "expiry-buyer"),
      createUserWithPassword(ctx.db, "expiry-other-buyer"),
    ]);
    const sign = (user: TestUser) =>
      ctx.jwtService.sign({ kind: "user", sub: user.id, email: user.email, role: "customer" });
    [ownerToken, buyerToken, otherBuyerToken] = [sign(owner), sign(buyer), sign(otherBuyer)];
  });

  beforeEach(() => {
    mp.preference.create.mockReset();
    mp.payment.get.mockReset();
  });

  afterEach(async () => {
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [owner, buyer, otherBuyer]);
    await ctx.close();
  });

  /** A pending booking owned by `owner`, already past its 10-minute deadline. */
  async function expiredPendingBooking(seatIds: string[]): Promise<string> {
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
    await expireDeadlineOf(ctx.db, bookingId);
    return bookingId;
  }

  /**
   * Same, but with a payment in flight recorded *before* the deadline passes,
   * so the sweeper suite running in parallel never sees it as expirable.
   */
  async function expiredPendingBookingWithPayment(seatIds: string[], paymentStatus: string): Promise<string> {
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
    await recordPayment(ctx.db, bookingId, paymentStatus);
    await expireDeadlineOf(ctx.db, bookingId);
    return bookingId;
  }

  it("AC1: deve criar a reserva pendente com prazo de 10 minutos", async () => {
    // GIVEN um assento livre
    const [seatId] = await fixture.addSeats(1);

    // WHEN o cliente reserva o assento
    const bookingId = await bookSeatsAsOrFail(ctx.app, buyerToken, sessionId, [seatId]);

    // THEN a reserva fica pendente com expires_at = created_at + 10 min, pelo relógio do banco
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    expect(await deadlineWindowSeconds(ctx.db, bookingId)).toBe(600);
  });

  it("AC2: deve mostrar como ocupado o assento de reserva pendente dentro do prazo", async () => {
    // GIVEN uma reserva pendente dentro do prazo
    const [seatId] = await fixture.addSeats(1);
    await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

    // WHEN outro cliente abre o mapa de assentos
    const status = await seatStatusSeenBy(ctx.app, buyerToken, sessionId, seatId);

    // THEN o assento aparece como ocupado
    expect(status).toBe("booked");
  });

  it("AC3: deve mostrar como livre o assento de reserva pendente vencida sem pagamento em andamento", async () => {
    // GIVEN uma reserva pendente vencida, sem pagamento e sem o sweeper ter rodado
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBooking([seatId]);

    // WHEN outro cliente abre o mapa de assentos
    const status = await seatStatusSeenBy(ctx.app, buyerToken, sessionId, seatId);

    // THEN o assento aparece como livre
    expect(status).toBe("free");
  });

  it("AC4: deve recusar hold em assento de reserva pendente dentro do prazo", async () => {
    // GIVEN uma reserva pendente dentro do prazo
    const [seatId] = await fixture.addSeats(1);
    await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

    // WHEN outro cliente tenta segurar o assento
    const response = await holdSeatAs(ctx.app, buyerToken, sessionId, seatId);

    // THEN o hold é recusado
    expect(response.statusCode).toBe(409);
  });

  it("AC4: deve permitir hold em assento de reserva pendente vencida", async () => {
    // GIVEN uma reserva pendente vencida, sem pagamento em andamento
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBooking([seatId]);

    // WHEN outro cliente tenta segurar o assento
    const response = await holdSeatAs(ctx.app, buyerToken, sessionId, seatId);

    // THEN o hold é aceito
    expect(response.statusCode).toBe(200);
  });

  it("AC5: deve reservar assento de reserva pendente vencida e marcar a antiga como expirada", async () => {
    // GIVEN uma reserva pendente vencida com dois assentos
    const [wantedSeatId, otherSeatId] = await fixture.addSeats(2);
    const oldBookingId = await expiredPendingBooking([wantedSeatId, otherSeatId]);

    // WHEN outro cliente reserva um dos assentos
    const response = await bookSeatsAs(ctx.app, buyerToken, sessionId, [wantedSeatId]);

    // THEN a reserva nova é criada, a antiga vira expirada e perde todos os assentos
    expect(response.statusCode).toBe(201);
    expect((await readBooking(ctx.db, oldBookingId)).status).toBe("expired");
    expect(await seatIdsOf(ctx.db, oldBookingId)).toEqual([]);
    expect(await seatStatusSeenBy(ctx.app, buyerToken, sessionId, otherSeatId)).toBe("free");
  });

  it("AC5: deve permitir só uma reserva quando duas pessoas disputam o mesmo assento vencido", async () => {
    // GIVEN uma reserva pendente vencida
    const [seatId] = await fixture.addSeats(1);
    const oldBookingId = await expiredPendingBooking([seatId]);

    // WHEN dois clientes reservam o mesmo assento ao mesmo tempo
    const responses = await Promise.all([
      bookSeatsAs(ctx.app, buyerToken, sessionId, [seatId]),
      bookSeatsAs(ctx.app, otherBuyerToken, sessionId, [seatId]),
    ]);

    // THEN só um consegue, o outro recebe 409, e a antiga fica expirada
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await readBooking(ctx.db, oldBookingId)).status).toBe("expired");
  });

  it("AC6: deve recusar reserva de assento com reserva pendente dentro do prazo", async () => {
    // GIVEN uma reserva pendente dentro do prazo
    const [seatId] = await fixture.addSeats(1);
    const oldBookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

    // WHEN outro cliente tenta reservar o assento
    const response = await bookSeatsAs(ctx.app, buyerToken, sessionId, [seatId]);

    // THEN a reserva é recusada e a antiga continua pendente
    expect(response.statusCode).toBe(409);
    expect((await readBooking(ctx.db, oldBookingId)).status).toBe("pending");
  });

  it("AC7: deve mostrar como ocupado o assento de reserva vencida com pagamento in_process", async () => {
    // GIVEN uma reserva pendente vencida com pagamento in_process
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBookingWithPayment([seatId], "in_process");

    // WHEN outro cliente abre o mapa de assentos
    const status = await seatStatusSeenBy(ctx.app, buyerToken, sessionId, seatId);

    // THEN o assento continua ocupado
    expect(status).toBe("booked");
  });

  it("AC7: deve recusar hold em assento de reserva vencida com pagamento in_process", async () => {
    // GIVEN uma reserva pendente vencida com pagamento in_process
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBookingWithPayment([seatId], "in_process");

    // WHEN outro cliente tenta segurar o assento
    const response = await holdSeatAs(ctx.app, buyerToken, sessionId, seatId);

    // THEN o hold é recusado
    expect(response.statusCode).toBe(409);
  });

  it("AC7: deve recusar nova reserva de assento de reserva vencida com pagamento in_process", async () => {
    // GIVEN uma reserva pendente vencida com pagamento in_process
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await expiredPendingBookingWithPayment([seatId], "in_process");

    // WHEN outro cliente tenta reservar o assento
    const response = await bookSeatsAs(ctx.app, buyerToken, sessionId, [seatId]);

    // THEN a reserva é recusada e a antiga continua pendente com o assento
    expect(response.statusCode).toBe(409);
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC7: deve mostrar como ocupado o assento de reserva vencida com pagamento pending", async () => {
    // GIVEN uma reserva pendente vencida com pagamento pending
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBookingWithPayment([seatId], "pending");

    // WHEN outro cliente abre o mapa de assentos
    const status = await seatStatusSeenBy(ctx.app, buyerToken, sessionId, seatId);

    // THEN o assento continua ocupado
    expect(status).toBe("booked");
  });

  it("AC7: deve recusar hold em assento de reserva vencida com pagamento pending", async () => {
    // GIVEN uma reserva pendente vencida com pagamento pending
    const [seatId] = await fixture.addSeats(1);
    await expiredPendingBookingWithPayment([seatId], "pending");

    // WHEN outro cliente tenta segurar o assento
    const response = await holdSeatAs(ctx.app, buyerToken, sessionId, seatId);

    // THEN o hold é recusado
    expect(response.statusCode).toBe(409);
  });

  it("AC7: deve recusar nova reserva de assento de reserva vencida com pagamento pending", async () => {
    // GIVEN uma reserva pendente vencida com pagamento pending
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await expiredPendingBookingWithPayment([seatId], "pending");

    // WHEN outro cliente tenta reservar o assento
    const response = await bookSeatsAs(ctx.app, buyerToken, sessionId, [seatId]);

    // THEN a reserva é recusada e a antiga continua pendente com o assento
    expect(response.statusCode).toBe(409);
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC12: deve confirmar reserva vencida quando o pagamento em andamento é aprovado", async () => {
    // GIVEN uma reserva pendente vencida com pagamento in_process e alguém olhando o mapa
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await expiredPendingBookingWithPayment([seatId], "in_process");
    const watcher = await watchSessionAs(ctx.baseUrl, buyerToken, sessionId);

    // WHEN o Mercado Pago avisa que o pagamento foi aprovado
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved");

    // THEN a reserva é confirmada, o mapa recebe "booked" e o e-mail de confirmação sai
    expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
    await watcher.waitFor((update) => update.seatId === seatId && update.status === "booked");
    await expect(findMailpitMessage(bookingId)).resolves.toBeDefined();
    watcher.close();
  });

  it("AC13: deve liberar a reserva e avisar o mapa quando o pagamento em andamento é rejeitado", async () => {
    // GIVEN uma reserva pendente com pagamento in_process e alguém olhando o mapa
    const seatIds = await fixture.addSeats(2);
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
    await recordPayment(ctx.db, bookingId, "in_process");
    const watcher = await watchSessionAs(ctx.baseUrl, buyerToken, sessionId);

    // WHEN o Mercado Pago avisa que o pagamento foi rejeitado
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "rejected");

    // THEN a reserva é cancelada, perde os assentos e cada assento é anunciado como liberado
    expect((await readBooking(ctx.db, bookingId)).status).toBe("cancelled");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([]);
    for (const seatId of seatIds) {
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "released");
    }
    watcher.close();
  });

  it("AC13: deve liberar a reserva e avisar o mapa quando o pagamento em andamento é cancelado", async () => {
    // GIVEN uma reserva pendente com pagamento pending e alguém olhando o mapa
    const seatIds = await fixture.addSeats(2);
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
    await recordPayment(ctx.db, bookingId, "pending");
    const watcher = await watchSessionAs(ctx.baseUrl, buyerToken, sessionId);

    // WHEN o Mercado Pago avisa que o pagamento foi cancelado
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "cancelled");

    // THEN a reserva é cancelada, perde os assentos e cada assento é anunciado como liberado
    expect((await readBooking(ctx.db, bookingId)).status).toBe("cancelled");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([]);
    for (const seatId of seatIds) {
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "released");
    }
    watcher.close();
  });

  it("AC14: deve registrar o pagamento aprovado e marcar a reserva expirada para revisão de estorno", async () => {
    // GIVEN uma reserva já expirada (sem assentos)
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [], status: "expired" });
    const warnings = captureWarnings();

    // WHEN chega um pagamento aprovado pra ela
    const paymentId = await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved");

    // THEN o pagamento fica aprovado, a reserva continua expirada e marcada pra revisão, sem assentos nem e-mail
    warnings.restore();
    expect((await readPayment(ctx.db, bookingId))?.status).toBe("approved");
    const booking = await readBooking(ctx.db, bookingId);
    expect(booking.status).toBe("expired");
    expect(booking.needsRefundReview).toBe(true);
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([]);
    const [warning] = warnings.mentioning(bookingId);
    expect(warning).toContain(`externalPaymentId=${paymentId}`);
    await settle(300);
    expect(await countMailpitMessages(bookingId)).toBe(0);
  });

  it("AC14: não deve repetir o alerta de estorno quando o mesmo webhook aprovado chega de novo", async () => {
    // GIVEN uma reserva expirada que já recebeu um pagamento aprovado
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [], status: "expired" });
    const warnings = captureWarnings();
    const paymentId = await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved");

    // WHEN o Mercado Pago reentrega o mesmo webhook
    await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", paymentId);

    // THEN o alerta de estorno aparece uma única vez
    warnings.restore();
    expect(warnings.mentioning(bookingId)).toHaveLength(1);
    expect((await readBooking(ctx.db, bookingId)).needsRefundReview).toBe(true);
  });

  it("AC15: deve recusar o checkout de reserva expirada com BOOKING_EXPIRED", async () => {
    // GIVEN uma reserva expirada do cliente
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [], status: "expired" });

    // WHEN ele tenta pagar
    const response = await checkoutAs(ctx.app, ownerToken, bookingId);

    // THEN recebe 409 com o código de reserva expirada e nenhuma preferência é criada
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
    expect(mp.preference.create).not.toHaveBeenCalled();
  });

  it("AC15: deve recusar a confirmação de reserva expirada com BOOKING_EXPIRED", async () => {
    // GIVEN uma reserva expirada do cliente
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [], status: "expired" });

    // WHEN ele tenta confirmar
    const response = await confirmAs(ctx.app, ownerToken, bookingId);

    // THEN recebe 409 com o código de reserva expirada
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
  });

  it("AC15: deve recusar o checkout de reserva pendente com prazo vencido com BOOKING_EXPIRED", async () => {
    // GIVEN uma reserva pendente do cliente com prazo vencido (sweeper ainda não passou)
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await expiredPendingBooking([seatId]);

    // WHEN ele tenta pagar
    const response = await checkoutAs(ctx.app, ownerToken, bookingId);

    // THEN recebe 409 com o código de reserva expirada e nenhuma preferência é criada
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      statusCode: 409,
      code: "BOOKING_EXPIRED",
      message: "Reserva expirada. Escolha os assentos novamente.",
    });
    expect(mp.preference.create).not.toHaveBeenCalled();
  });

  it("AC15: deve recusar a confirmação de reserva pendente com prazo vencido com BOOKING_EXPIRED", async () => {
    // GIVEN uma reserva pendente do cliente com prazo vencido (sweeper ainda não passou)
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await expiredPendingBooking([seatId]);

    // WHEN ele tenta confirmar
    const response = await confirmAs(ctx.app, ownerToken, bookingId);

    // THEN recebe 409 com o código de reserva expirada e a reserva não é confirmada
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
    expect((await readBooking(ctx.db, bookingId)).status).not.toBe("confirmed");
  });

  it("AC17: deve avisar a sala da sessão que os assentos foram reservados", async () => {
    // GIVEN dois assentos livres e alguém olhando o mapa
    const seatIds = await fixture.addSeats(2);
    const watcher = await watchSessionAs(ctx.baseUrl, otherBuyerToken, sessionId);

    // WHEN o cliente reserva os dois assentos
    await bookSeatsAsOrFail(ctx.app, buyerToken, sessionId, seatIds);

    // THEN a sala recebe "booked" para cada assento
    for (const seatId of seatIds) {
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "booked");
    }
    watcher.close();
  });

  it("AC18: deve tratar como vencida a reserva pendente antiga depois da migration", async () => {
    // GIVEN uma reserva pendente criada há 1h, de antes da coluna expires_at existir
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
    await backdateCreationOnly(ctx.db, bookingId, 1);

    // WHEN o backfill da migration roda
    await runExpiresAtBackfillFor(ctx.db, bookingId);

    // THEN expires_at = created_at + 10 min, as colunas novas ficam nos defaults e o assento aparece livre
    expect(await deadlineWindowSeconds(ctx.db, bookingId)).toBe(600);
    const booking = await readBooking(ctx.db, bookingId);
    expect(booking.needsRefundReview).toBe(false);
    expect(booking.stalePaymentAlertedAt).toBeNull();
    expect(await seatStatusSeenBy(ctx.app, buyerToken, sessionId, seatId)).toBe("free");
  });

  it("AC19: deve criar a preferência do Mercado Pago com validade igual ao prazo da reserva", async () => {
    // GIVEN uma reserva recém-criada pelo cliente
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await bookSeatsAsOrFail(ctx.app, buyerToken, sessionId, [seatId]);
    mp.preference.create.mockResolvedValue({ init_point: "https://mp.test/checkout/expiry" });

    // WHEN ele vai pro pagamento
    const response = await checkoutAs(ctx.app, buyerToken, bookingId);

    // THEN a preferência expira junto com a reserva
    expect(response.statusCode).toBe(200);
    const body = mp.preference.create.mock.calls[0][0].body;
    expect(body.expires).toBe(true);
    const { expiresAt } = await readBooking(ctx.db, bookingId);
    expect(new Date(body.expiration_date_to).getTime()).toBe(expiresAt.getTime());
  });
});
