import { randomUUID } from "node:crypto";
import {
  CinemaFixture,
  createCinemaFixture,
  createUserWithPassword,
  deleteUsers,
  TestUser,
} from "./helpers/cinema-fixture";
import { clearSessionHolds, watchSessionAs } from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";
import { countMailpitMessages, findMailpitMessage } from "./helpers/mailpit";
import {
  attemptPaymentEventsDelete,
  attemptPaymentEventsUpdate,
  bookSeatsAs,
  bookSeatsAsOrFail,
  bookSingleSeatAs,
  captureWarnings,
  deletePaymentsOfSessions,
  deliverLegacyIpnBodyWebhook,
  deliverLegacyIpnQueryWebhook,
  deliverPaymentWebhook,
  expireDeadlineOf,
  failBookingConfirmationOnce,
  insertBooking,
  insertBookingWithPrices,
  MercadoPagoMocks,
  mercadoPagoMocks,
  payBookingAs,
  paymentSummaryAs,
  readBooking,
  readPayment,
  readPaymentAttempt,
  readPaymentEvents,
  readPaymentsOfBooking,
  recordPayment,
  removedCheckoutProAs,
  seatIdsOf,
  settle,
  validPaymentBody,
} from "./helpers/pending-booking";

// Spec: docs/flows/checkout-transparente/spec.md (AC1, AC7-AC10, AC12-AC32)
describe("Checkout transparente (e2e)", () => {
  let ctx: GuestFlowApp;
  let mp: MercadoPagoMocks;
  let fixture: CinemaFixture;
  let sessionId: string;
  let owner: TestUser;
  let otherUser: TestUser;
  let ownerToken: string;
  let otherUserToken: string;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    mp = mercadoPagoMocks(ctx.app);
    fixture = await createCinemaFixture(ctx.db, `Checkout Transparente E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    [owner, otherUser] = await Promise.all([
      createUserWithPassword(ctx.db, "transparent-owner"),
      createUserWithPassword(ctx.db, "transparent-other"),
    ]);
    const sign = (user: TestUser) =>
      ctx.jwtService.sign({ kind: "user", sub: user.id, email: user.email, role: "customer" });
    [ownerToken, otherUserToken] = [sign(owner), sign(otherUser)];
  });

  beforeEach(() => {
    mp.payment.create.mockReset();
    mp.payment.get.mockReset();
  });

  afterEach(async () => {
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [owner, otherUser]);
    await ctx.close();
  });

  describe("GET /bookings/:id/payment-summary (AC1)", () => {
    it("AC1: deve devolver o total da reserva pendente somando os preços dos assentos", async () => {
      // GIVEN uma reserva pendente do próprio usuário com uma inteira (3000) e uma meia (1500)
      const [firstSeatId, secondSeatId] = await fixture.addSeats(2);
      const bookingId = await insertBookingWithPrices(ctx.db, {
        userId: owner.id,
        sessionId,
        seats: [
          { seatId: firstSeatId, ticketType: "full", priceCents: 3000 },
          { seatId: secondSeatId, ticketType: "half", priceCents: 1500 },
        ],
      });

      // WHEN o usuário consulta o resumo de pagamento da reserva
      const response = await paymentSummaryAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 200 com amountCents = 4500, lista de assentos e expiresAt
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        bookingId,
        status: "pending",
        amountCents: 4500,
        currency: "BRL",
        seats: [
          { seatId: firstSeatId, ticketType: "full", priceCents: 3000 },
          { seatId: secondSeatId, ticketType: "half", priceCents: 1500 },
        ],
      });
      const stored = await readBooking(ctx.db, bookingId);
      expect(body.expiresAt).toBe(stored.expiresAt.toISOString());
    });

    it("AC1: deve responder 404 para reserva de outro usuário", async () => {
      // GIVEN uma reserva pendente pertencente a outro usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN outro usuário consulta o resumo dessa reserva
      const response = await paymentSummaryAs(ctx.app, otherUserToken, bookingId);

      // THEN recebe 404
      expect(response.statusCode).toBe(404);
    });

    it("AC1: deve responder 409 BOOKING_EXPIRED para reserva vencida", async () => {
      // GIVEN uma reserva pendente do usuário cujo prazo já venceu
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      await expireDeadlineOf(ctx.db, bookingId);

      // WHEN o usuário consulta o resumo de pagamento
      const response = await paymentSummaryAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 com código BOOKING_EXPIRED
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
    });

    it("AC1: deve responder 409 BOOKING_NOT_PENDING para reserva confirmada", async () => {
      // GIVEN uma reserva já confirmada do usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });

      // WHEN o usuário consulta o resumo de pagamento
      const response = await paymentSummaryAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 com código BOOKING_NOT_PENDING
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_NOT_PENDING" });
    });
  });

  describe("Retomada de reserva pendente do próprio usuário (AC7-AC8)", () => {
    it("AC7: deve devolver a reserva pendente do próprio usuário em vez de criar outra", async () => {
      // GIVEN que o usuário já tem uma reserva pendente dentro do prazo para aqueles dois assentos
      const seatIds = await fixture.addSeats(2);
      const existingBookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, seatIds);

      // WHEN o mesmo usuário tenta reservar exatamente o mesmo conjunto de assentos novamente
      const response = await bookSeatsAs(ctx.app, ownerToken, sessionId, seatIds);

      // THEN recebe 409 BOOKING_ALREADY_PENDING com o bookingId existente
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        statusCode: 409,
        code: "BOOKING_ALREADY_PENDING",
        bookingId: existingBookingId,
        message: "Você já tem uma reserva pendente para esses assentos.",
      });
    });

    it("AC7: deve devolver a reserva pendente do próprio usuário também na rota de assento único", async () => {
      // GIVEN que o usuário já tem uma reserva pendente dentro do prazo para um assento
      const [seatId] = await fixture.addSeats(1);
      const existingBookingId = await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);

      // WHEN o mesmo usuário chama POST /sessions/:id/seats/:seatId/book para o mesmo assento
      const response = await bookSingleSeatAs(ctx.app, ownerToken, sessionId, seatId);

      // THEN recebe 409 BOOKING_ALREADY_PENDING com o bookingId existente
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        statusCode: 409,
        code: "BOOKING_ALREADY_PENDING",
        bookingId: existingBookingId,
        message: "Você já tem uma reserva pendente para esses assentos.",
      });
    });

    it("AC8: deve responder 409 sem bookingId quando o conflito é com reserva de outro usuário", async () => {
      // GIVEN uma reserva pendente pertencente a outro usuário
      const [seatId] = await fixture.addSeats(1);
      await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [seatId]);

      // WHEN um segundo usuário tenta reservar o mesmo assento
      const response = await bookSeatsAs(ctx.app, otherUserToken, sessionId, [seatId]);

      // THEN recebe 409 comum, sem vazar bookingId
      expect(response.statusCode).toBe(409);
      expect(response.json()).not.toHaveProperty("bookingId");
      expect(response.json()).not.toHaveProperty("code");
    });

    it("AC8: deve responder 409 sem bookingId quando a reserva pendente do mesmo usuário tem conjunto de assentos diferente", async () => {
      // GIVEN que o usuário já tem uma reserva pendente apenas para o primeiro assento
      const [firstSeatId, secondSeatId] = await fixture.addSeats(2);
      await bookSeatsAsOrFail(ctx.app, ownerToken, sessionId, [firstSeatId]);

      // WHEN o mesmo usuário tenta reservar o primeiro assento junto com um segundo assento
      const response = await bookSeatsAs(ctx.app, ownerToken, sessionId, [firstSeatId, secondSeatId]);

      // THEN recebe 409 comum sem bookingId
      expect(response.statusCode).toBe(409);
      expect(response.json()).not.toHaveProperty("bookingId");
      expect(response.json()).not.toHaveProperty("code");
    });
  });

  describe("POST /bookings/:id/payments (AC9-AC21)", () => {
    it("AC9: deve confirmar a reserva na própria resposta quando o cartão é aprovado", async () => {
      // GIVEN uma reserva pendente do usuário, alguém assistindo ao mapa e o Mercado Pago aprovando o cartão
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const watcher = await watchSessionAs(ctx.baseUrl, otherUserToken, sessionId);
      const attemptId = randomUUID();
      mp.payment.create.mockResolvedValue({
        id: 8001,
        status: "approved",
        status_detail: "accredited",
        installments: 1,
        payment_method_id: "visa",
        transaction_amount: 30,
      });

      // WHEN o usuário envia o pagamento com cartão
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN a resposta traz status approved e bookingStatus confirmed, o mapa recebe booked e o e-mail é enviado
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        attemptId,
        paymentId: "8001",
        status: "approved",
        statusDetail: "accredited",
        message: "Pagamento aprovado!",
        bookingStatus: "confirmed",
      });
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "booked");
      await expect(findMailpitMessage(bookingId)).resolves.toBeDefined();
      watcher.close();
    });

    it("AC10: deve cobrar o total calculado no servidor mesmo com valor adulterado no corpo", async () => {
      // GIVEN uma reserva pendente com dois assentos somando 4500 centavos (R$ 45,00)
      const [firstSeatId, secondSeatId] = await fixture.addSeats(2);
      const bookingId = await insertBookingWithPrices(ctx.db, {
        userId: owner.id,
        sessionId,
        seats: [
          { seatId: firstSeatId, ticketType: "full", priceCents: 3000 },
          { seatId: secondSeatId, ticketType: "half", priceCents: 1500 },
        ],
      });
      mp.payment.create.mockResolvedValue({
        id: 8002,
        status: "approved",
        status_detail: "accredited",
      });

      // WHEN o cliente envia amount e transaction_amount adulterados para R$ 1,00 no corpo
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ amount: 1, transactionAmount: 1, transaction_amount: 1 }),
      );

      // THEN a requisição é processada cobrando exatamente R$ 45,00 calculados pelo banco
      expect(response.statusCode).toBe(200);
      expect(mp.payment.create).toHaveBeenCalledTimes(1);
      expect(mp.payment.create.mock.calls[0][0].body.transaction_amount).toBe(45);
    });

    it("AC12: deve gravar a tentativa antes de chamar o Mercado Pago", async () => {
      // GIVEN uma reserva pendente e um mock do Mercado Pago que inspeciona o banco durante a chamada HTTP
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      let attemptDuringMpCall: Awaited<ReturnType<typeof readPaymentAttempt>>;
      let eventsDuringMpCall: Awaited<ReturnType<typeof readPaymentEvents>> = [];

      mp.payment.create.mockImplementation(async () => {
        attemptDuringMpCall = await readPaymentAttempt(ctx.db, attemptId);
        eventsDuringMpCall = await readPaymentEvents(ctx.db, bookingId);
        return { id: 8003, status: "approved", status_detail: "accredited" };
      });

      // WHEN o usuário envia o pagamento
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN no momento em que o Mercado Pago foi chamado, a tentativa já estava commitada com status created e evento attempt_created
      expect(response.statusCode).toBe(200);
      expect(attemptDuringMpCall).toMatchObject({
        id: attemptId,
        bookingId,
        status: "created",
        amountCents: 3000,
      });
      expect(eventsDuringMpCall.map((event) => event.type)).toEqual(["attempt_created"]);
    });

    it("AC13: deve devolver o resultado guardado ao reenviar a mesma tentativa", async () => {
      // GIVEN uma tentativa que já foi aprovada e confirmou a reserva
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockResolvedValue({
        id: 8004,
        status: "approved",
        status_detail: "accredited",
      });
      const firstResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );
      expect(firstResponse.statusCode).toBe(200);
      mp.payment.create.mockClear();

      // WHEN o cliente reenvia a requisição com o mesmo attemptId
      const replayResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN devolve exatamente o mesmo resultado sem chamar o Mercado Pago novamente
      expect(replayResponse.statusCode).toBe(200);
      expect(replayResponse.json()).toEqual(firstResponse.json());
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC14: deve repetir a chamada com a mesma chave quando a tentativa ficou sem resposta", async () => {
      // GIVEN uma tentativa que falhou por timeout na primeira chamada ao Mercado Pago (ficando com status created)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockRejectedValueOnce(new Error("request timeout"));

      const timeoutResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId, token: "same-card-token" }),
      );
      expect(timeoutResponse.statusCode).toBe(504);
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("created");

      // WHEN o cliente clica em "Tentar de novo" reenviando o mesmo attemptId e o mesmo token
      mp.payment.create.mockResolvedValueOnce({
        id: 8005,
        status: "approved",
        status_detail: "accredited",
      });
      const retryResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId, token: "same-card-token" }),
      );

      // THEN o Mercado Pago é chamado novamente com a mesma chave de idempotência e apenas uma linha de pagamento existe para a reserva
      expect(retryResponse.statusCode).toBe(200);
      expect(mp.payment.create).toHaveBeenCalledTimes(2);
      expect(mp.payment.create.mock.calls[0][0].requestOptions.idempotencyKey).toBe(attemptId);
      expect(mp.payment.create.mock.calls[1][0].requestOptions.idempotencyKey).toBe(attemptId);
      const attempts = await readPaymentsOfBooking(ctx.db, bookingId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ id: attemptId, status: "approved", externalPaymentId: "8005" });
    });

    it("AC15: deve deixar só uma de duas tentativas simultâneas chegar ao Mercado Pago", async () => {
      // GIVEN uma reserva pendente e um provedor de pagamento em que a chamada leva alguns milissegundos
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      mp.payment.create.mockImplementation(async () => {
        await settle(80);
        return { id: 8006, status: "approved", status_detail: "accredited" };
      });

      // WHEN duas requisições simultâneas com attemptIds diferentes são disparadas para a mesma reserva
      const responses = await Promise.all([
        payBookingAs(ctx.app, ownerToken, bookingId, validPaymentBody({ attemptId: randomUUID() })),
        payBookingAs(ctx.app, ownerToken, bookingId, validPaymentBody({ attemptId: randomUUID() })),
      ]);

      // THEN apenas uma chega ao Mercado Pago (200) e a outra é bloqueada com 409 PAYMENT_IN_PROGRESS
      expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const conflictResponse = responses.find((res) => res.statusCode === 409)!;
      expect(conflictResponse.json()).toMatchObject({
        statusCode: 409,
        code: "PAYMENT_IN_PROGRESS",
      });
      expect(mp.payment.create).toHaveBeenCalledTimes(1);
    });

    it("AC16: deve bloquear nova tentativa enquanto outra da mesma reserva está in_process", async () => {
      // GIVEN uma reserva pendente que já possui uma tentativa com status in_process
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      await recordPayment(ctx.db, bookingId, "in_process");

      // WHEN o usuário envia uma nova tentativa de pagamento
      const response = await payBookingAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 PAYMENT_IN_PROGRESS sem chamar o Mercado Pago
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "PAYMENT_IN_PROGRESS" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC16: deve bloquear nova tentativa enquanto outra da mesma reserva está pending", async () => {
      // GIVEN uma reserva pendente que já possui uma tentativa com status pending
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      await recordPayment(ctx.db, bookingId, "pending");

      // WHEN o usuário envia uma nova tentativa de pagamento
      const response = await payBookingAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 PAYMENT_IN_PROGRESS sem chamar o Mercado Pago
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "PAYMENT_IN_PROGRESS" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC17: deve recusar identificador de tentativa já usado em outra reserva", async () => {
      // GIVEN um attemptId já utilizado em outra reserva
      const [firstSeatId, secondSeatId] = await fixture.addSeats(2);
      const firstBookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [firstSeatId],
      });
      const secondBookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [secondSeatId],
      });
      const sharedAttemptId = randomUUID();
      await recordPayment(ctx.db, firstBookingId, "rejected", { id: sharedAttemptId });

      // WHEN o usuário tenta usar o mesmo attemptId na segunda reserva
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        secondBookingId,
        validPaymentBody({ attemptId: sharedAttemptId }),
      );

      // THEN recebe 409 ATTEMPT_ID_CONFLICT sem chamar o Mercado Pago
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "ATTEMPT_ID_CONFLICT" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC18: deve manter a reserva pendente e permitir nova tentativa após cartão recusado", async () => {
      // GIVEN uma reserva pendente cujo primeiro cartão é recusado por saldo insuficiente
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const firstAttemptId = randomUUID();
      mp.payment.create.mockResolvedValueOnce({
        id: 8010,
        status: "rejected",
        status_detail: "cc_rejected_insufficient_amount",
      });

      const declinedResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId: firstAttemptId }),
      );

      expect(declinedResponse.statusCode).toBe(200);
      expect(declinedResponse.json()).toEqual({
        attemptId: firstAttemptId,
        paymentId: "8010",
        status: "rejected",
        statusDetail: "cc_rejected_insufficient_amount",
        message: "Saldo ou limite insuficiente. Use outro cartão.",
        bookingStatus: "pending",
      });
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");

      // WHEN o usuário tenta novamente na mesma reserva com outro attemptId e o novo cartão é aprovado
      const secondAttemptId = randomUUID();
      mp.payment.create.mockResolvedValueOnce({
        id: 8011,
        status: "approved",
        status_detail: "accredited",
      });
      const approvedResponse = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId: secondAttemptId }),
      );

      // THEN a segunda tentativa confirma a reserva e as duas tentativas ficam registradas em payments
      expect(approvedResponse.statusCode).toBe(200);
      expect(approvedResponse.json()).toMatchObject({
        attemptId: secondAttemptId,
        paymentId: "8011",
        status: "approved",
        bookingStatus: "confirmed",
      });
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      const attempts = await readPaymentsOfBooking(ctx.db, bookingId);
      expect(attempts.map((a) => ({ id: a.id, status: a.status }))).toEqual([
        { id: firstAttemptId, status: "rejected" },
        { id: secondAttemptId, status: "approved" },
      ]);
    });

    it("AC19: deve manter a reserva pendente com pagamento em análise", async () => {
      // GIVEN uma reserva pendente cujo pagamento retorna in_process do Mercado Pago
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockResolvedValue({
        id: 8012,
        status: "in_process",
        status_detail: "pending_review_manual",
      });

      // WHEN o usuário envia o pagamento
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN responde "em análise", mantém a reserva pending e depois confirma via webhook
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        attemptId,
        paymentId: "8012",
        status: "in_process",
        statusDetail: "pending_review_manual",
        message: "Pagamento em análise. Você recebe a confirmação por e-mail.",
        bookingStatus: "pending",
      });
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");

      await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", 8012);
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
    });

    it("AC20: deve responder 422 PAYMENT_REQUEST_INVALID e marcar request_failed quando o Mercado Pago recusa a requisição com 4xx", async () => {
      // GIVEN uma reserva pendente e o Mercado Pago rejeitando a requisição com erro HTTP 400 (ex: token inválido)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockRejectedValue(
        Object.assign(new Error("Invalid card token"), {
          status: 400,
          cause: [{ code: "3003" }],
        }),
      );

      // WHEN o usuário envia o pagamento
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN responde 422 PAYMENT_REQUEST_INVALID, a tentativa fica request_failed e a reserva continua pending
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ statusCode: 422, code: "PAYMENT_REQUEST_INVALID" });
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("request_failed");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
      const events = await readPaymentEvents(ctx.db, bookingId);
      expect(events.map((e) => e.type)).toEqual(["attempt_created", "mp_request_failed"]);
      expect(events[1].payload).toMatchObject({ error_code: "3003" });
    });

    it("AC20: deve responder 504 PAYMENT_PROVIDER_TIMEOUT e manter a tentativa created quando o Mercado Pago não responde", async () => {
      // GIVEN uma reserva pendente e uma falha de timeout na chamada ao Mercado Pago
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockRejectedValue(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));

      // WHEN o usuário envia o pagamento
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );

      // THEN responde 504 PAYMENT_PROVIDER_TIMEOUT e a tentativa permanece como created
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ statusCode: 504, code: "PAYMENT_PROVIDER_TIMEOUT" });
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("created");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    });

    it("AC21: deve responder 409 BOOKING_EXPIRED para reserva com status expired sem chamar o Mercado Pago", async () => {
      // GIVEN uma reserva com status expired
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [],
        status: "expired",
      });

      // WHEN o usuário tenta pagar
      const response = await payBookingAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 BOOKING_EXPIRED e o Mercado Pago não é chamado
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC21: deve responder 409 BOOKING_EXPIRED para reserva pendente vencida sem chamar o Mercado Pago", async () => {
      // GIVEN uma reserva pending cujo expires_at já passou
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      await expireDeadlineOf(ctx.db, bookingId);

      // WHEN o usuário tenta pagar
      const response = await payBookingAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 BOOKING_EXPIRED e o Mercado Pago não é chamado
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_EXPIRED" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC21: deve responder 404 para reserva de outro usuário sem chamar o Mercado Pago", async () => {
      // GIVEN uma reserva pendente de outro usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN outro usuário tenta pagar essa reserva
      const response = await payBookingAs(ctx.app, otherUserToken, bookingId);

      // THEN recebe 404 e o Mercado Pago não é chamado
      expect(response.statusCode).toBe(404);
      expect(mp.payment.create).not.toHaveBeenCalled();
    });

    it("AC21: deve responder 409 BOOKING_NOT_PENDING para reserva confirmada sem chamar o Mercado Pago", async () => {
      // GIVEN uma reserva já confirmada do usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });

      // WHEN o usuário tenta pagar novamente
      const response = await payBookingAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 BOOKING_NOT_PENDING e o Mercado Pago não é chamado
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ statusCode: 409, code: "BOOKING_NOT_PENDING" });
      expect(mp.payment.create).not.toHaveBeenCalled();
    });
  });

  describe("POST /payments/webhook (AC22-AC28)", () => {
    it("AC22: deve manter a reserva pendente quando o webhook reporta pagamento rejected", async () => {
      // GIVEN uma reserva pendente com tentativa em andamento
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = await recordPayment(ctx.db, bookingId, "in_process", {
        externalPaymentId: "8101",
      });

      // WHEN chega o webhook reportando status rejected
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "rejected", 8101);

      // THEN a tentativa fica rejected, mas a reserva permanece pending com seu assento
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("rejected");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
      expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
    });

    it("AC22: deve manter a reserva pendente quando o webhook reporta pagamento cancelled", async () => {
      // GIVEN uma reserva pendente com tentativa em andamento
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = await recordPayment(ctx.db, bookingId, "pending", {
        externalPaymentId: "8102",
      });

      // WHEN chega o webhook reportando status cancelled
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "cancelled", 8102);

      // THEN a tentativa fica cancelled, mas a reserva permanece pending com seu assento
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("cancelled");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
      expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
    });

    it("AC23: deve ignorar recusa atrasada de tentativa antiga em reserva já confirmada", async () => {
      // GIVEN uma reserva com uma tentativa antiga e uma segunda tentativa já aprovada que confirmou a reserva
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });
      const oldAttemptId = await recordPayment(ctx.db, bookingId, "in_process", {
        externalPaymentId: "8103",
      });
      const approvedAttemptId = await recordPayment(ctx.db, bookingId, "approved", {
        externalPaymentId: "8104",
      });

      // WHEN chega um webhook rejected atrasado para a tentativa antiga e também uma entrega atrasada rejected para a tentativa aprovada
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "rejected", 8103);
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "rejected", 8104);

      // THEN a reserva permanece confirmed e a linha aprovada não regride de status
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      expect((await readPaymentAttempt(ctx.db, oldAttemptId))?.status).toBe("rejected");
      expect((await readPaymentAttempt(ctx.db, approvedAttemptId))?.status).toBe("approved");
    });

    it("AC24: deve reconciliar pelo webhook a tentativa sem id de pagamento gravado", async () => {
      // GIVEN uma tentativa que ficou como created sem external_payment_id (tx2 não chegou a rodar)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = await recordPayment(ctx.db, bookingId, "created", {
        externalPaymentId: null,
      });

      // WHEN chega o webhook trazendo metadata.attempt_id correspondente e status approved
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", {
        paymentId: 8105,
        attemptId,
        statusDetail: "accredited",
      });

      // THEN a tentativa é localizada por metadata.attempt_id, grava external_payment_id = "8105", vira approved e confirma a reserva
      const reconciled = await readPaymentAttempt(ctx.db, attemptId);
      expect(reconciled).toMatchObject({
        id: attemptId,
        externalPaymentId: "8105",
        status: "approved",
        statusDetail: "accredited",
      });
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
    });

    it("AC25: deve confirmar uma única vez com webhook aprovado repetido", async () => {
      // GIVEN uma reserva pendente com alguém assistindo ao mapa
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      await recordPayment(ctx.db, bookingId, "in_process", { externalPaymentId: "8106" });
      const watcher = await watchSessionAs(ctx.baseUrl, otherUserToken, sessionId);

      // WHEN o mesmo webhook approved é entregue duas vezes seguidas
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", 8106);
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", 8106);

      // THEN a reserva é confirmada uma única vez (um broadcast booked, um e-mail e um evento booking_confirmed)
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "booked");
      await settle(250);
      const bookedBroadcasts = watcher.updates.filter(
        (update) => update.seatId === seatId && update.status === "booked",
      );
      expect(bookedBroadcasts).toHaveLength(1);
      expect(await countMailpitMessages(bookingId)).toBe(1);
      const events = await readPaymentEvents(ctx.db, bookingId);
      expect(events.filter((e) => e.type === "booking_confirmed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "webhook_received")).toHaveLength(2);
      watcher.close();
    });

    it("AC26: deve registrar status refunded no webhook sem mudar a reserva e emitir log warn", async () => {
      // GIVEN uma reserva confirmada com pagamento aprovado
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });
      const attemptId = await recordPayment(ctx.db, bookingId, "approved", {
        externalPaymentId: "8107",
      });
      const warnings = captureWarnings();

      // WHEN chega um webhook com status refunded
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "refunded", 8107);

      // THEN grava o status refunded na tentativa, mantém a reserva confirmed e registra um log warn
      warnings.restore();
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("refunded");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      expect(warnings.mentioning(bookingId)).toHaveLength(1);
    });

    it("AC26: deve registrar status charged_back no webhook sem mudar a reserva e emitir log warn", async () => {
      // GIVEN uma reserva confirmada com pagamento aprovado
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });
      const attemptId = await recordPayment(ctx.db, bookingId, "approved", {
        externalPaymentId: "8108",
      });
      const warnings = captureWarnings();

      // WHEN chega um webhook com status charged_back
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "charged_back", 8108);

      // THEN grava o status charged_back na tentativa, mantém a reserva confirmed e registra um log warn
      warnings.restore();
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("charged_back");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      expect(warnings.mentioning(bookingId)).toHaveLength(1);
    });

    it("AC26: deve registrar status in_mediation no webhook sem mudar a reserva e emitir log warn", async () => {
      // GIVEN uma reserva confirmada com pagamento aprovado
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [seatId],
        status: "confirmed",
      });
      const attemptId = await recordPayment(ctx.db, bookingId, "approved", {
        externalPaymentId: "8109",
      });
      const warnings = captureWarnings();

      // WHEN chega um webhook com status in_mediation
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "in_mediation", 8109);

      // THEN grava o status in_mediation na tentativa, mantém a reserva confirmed e registra um log warn
      warnings.restore();
      expect((await readPaymentAttempt(ctx.db, attemptId))?.status).toBe("in_mediation");
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      expect(warnings.mentioning(bookingId)).toHaveLength(1);
    });

    it("AC27: deve registrar o pagamento aprovado sem reativar a reserva expirada", async () => {
      // GIVEN uma reserva já expirada
      const bookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [],
        status: "expired",
      });
      const warnings = captureWarnings();

      // WHEN chega um webhook approved para essa reserva
      const paymentId = await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", 8110);

      // THEN o pagamento fica approved, a reserva continua expired com needsRefundReview = true e um alerta é emitido
      warnings.restore();
      expect((await readPayment(ctx.db, bookingId))?.status).toBe("approved");
      const booking = await readBooking(ctx.db, bookingId);
      expect(booking.status).toBe("expired");
      expect(booking.needsRefundReview).toBe(true);
      expect(warnings.mentioning(bookingId)[0]).toContain(`externalPaymentId=${paymentId}`);
    });

    it("AC28: deve processar webhook no formato IPN legado no corpo criando tentativa por external_reference", async () => {
      // GIVEN uma reserva pendente de uma Preference antiga (sem linha prévia em payments)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN chega uma notificação IPN com topic/resource no corpo JSON
      const paymentId = await deliverLegacyIpnBodyWebhook(ctx.app, mp, bookingId, "approved", 8111);

      // THEN cria uma linha em payments por external_reference e confirma a reserva
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      const payment = await readPayment(ctx.db, bookingId);
      expect(payment).toMatchObject({
        bookingId,
        externalPaymentId: String(paymentId),
        status: "approved",
      });
    });

    it("AC28: deve processar webhook no formato IPN legado só na query criando tentativa por external_reference", async () => {
      // GIVEN uma reserva pendente de uma Preference antiga (sem linha prévia em payments)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN chega uma notificação IPN apenas com ?topic=payment&id= na query
      const paymentId = await deliverLegacyIpnQueryWebhook(ctx.app, mp, bookingId, "approved", 8112);

      // THEN cria uma linha em payments por external_reference e confirma a reserva
      expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
      const payment = await readPayment(ctx.db, bookingId);
      expect(payment).toMatchObject({
        bookingId,
        externalPaymentId: String(paymentId),
        status: "approved",
      });
    });
  });

  describe("Histórico append-only payment_events e remoção do Checkout Pro (AC29-AC32)", () => {
    it("AC29: deve registrar o histórico completo de uma tentativa aprovada", async () => {
      // GIVEN uma reserva pendente e o Mercado Pago aprovando o pagamento
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockResolvedValue({
        id: 8201,
        status: "approved",
        status_detail: "accredited",
        installments: 1,
        payment_method_id: "visa",
        transaction_amount: 30,
      });

      // WHEN o pagamento síncrono é aprovado e depois o webhook do mesmo pagamento chega
      await payBookingAs(ctx.app, ownerToken, bookingId, validPaymentBody({ attemptId }));
      await deliverPaymentWebhook(ctx.app, mp, bookingId, "approved", 8201);

      // THEN payment_events registra na ordem: attempt_created, mp_response, booking_confirmed e webhook_received
      const events = await readPaymentEvents(ctx.db, bookingId);
      expect(events.map((event) => event.type)).toEqual([
        "attempt_created",
        "mp_response",
        "booking_confirmed",
        "webhook_received",
      ]);
      for (const event of events) {
        expect(event.paymentId).toBe(attemptId);
      }
    });

    it("AC29: não deve deixar evento quando a transação falha", async () => {
      // GIVEN uma reserva pendente onde a tx2 falha após inserir mp_response
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      mp.payment.create.mockResolvedValue({
        id: 8202,
        status: "approved",
        status_detail: "accredited",
      });
      const restore = failBookingConfirmationOnce(ctx.app);

      // WHEN a chamada falha durante a tx2
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({ attemptId }),
      );
      restore();

      // THEN o rollback da tx2 desfaz o evento mp_response e o booking_confirmed (resta apenas attempt_created da tx1)
      expect(response.statusCode).toBe(500);
      const events = await readPaymentEvents(ctx.db, bookingId);
      expect(events.map((event) => event.type)).toEqual(["attempt_created"]);
      expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    });

    it("AC30: não deve gravar dados pessoais nem de cartão no histórico", async () => {
      // GIVEN uma requisição de pagamento contendo token de cartão, CPF, e-mail e nome do titular
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      const attemptId = randomUUID();
      const sensitiveToken = "tok_secret_card_999888777";
      const sensitiveCpf = "98765432100";
      const sensitiveEmail = "titular.secreto@exemplo.com";
      const sensitiveName = "Titular Super Secreto";
      mp.payment.create.mockResolvedValue({
        id: 8203,
        status: "approved",
        status_detail: "accredited",
      });

      // WHEN o pagamento é processado
      const response = await payBookingAs(
        ctx.app,
        ownerToken,
        bookingId,
        validPaymentBody({
          attemptId,
          token: sensitiveToken,
          cardholderName: sensitiveName,
          payer: {
            email: sensitiveEmail,
            identification: { type: "CPF", number: sensitiveCpf },
          },
        }),
      );

      // THEN nenhum evento em payment_events contém token, CPF, e-mail ou nome do titular
      expect(response.statusCode).toBe(200);
      const events = await readPaymentEvents(ctx.db, bookingId);
      expect(events.length).toBeGreaterThanOrEqual(3);
      for (const event of events) {
        const serialized = JSON.stringify(event.payload);
        expect(serialized).not.toContain(sensitiveToken);
        expect(serialized).not.toContain(sensitiveCpf);
        expect(serialized).not.toContain(sensitiveEmail);
        expect(serialized).not.toContain(sensitiveName);
      }
    });

    it("AC31: deve falhar ao executar UPDATE em payment_events no banco", async () => {
      // GIVEN um evento gravado em payment_events
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      mp.payment.create.mockResolvedValue({
        id: 8204,
        status: "approved",
        status_detail: "accredited",
      });
      await payBookingAs(ctx.app, ownerToken, bookingId);
      const [event] = await readPaymentEvents(ctx.db, bookingId);

      // WHEN alguém tenta executar UPDATE na linha de payment_events
      const updateAttempt = attemptPaymentEventsUpdate(ctx.db, event.id);

      // THEN o banco recusa a alteração por causa da trigger append-only
      await expect(updateAttempt).rejects.toThrow(/append-only/i);
    });

    it("AC31: deve falhar ao executar DELETE em payment_events no banco", async () => {
      // GIVEN um evento gravado em payment_events
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });
      mp.payment.create.mockResolvedValue({
        id: 8205,
        status: "approved",
        status_detail: "accredited",
      });
      await payBookingAs(ctx.app, ownerToken, bookingId);
      const [event] = await readPaymentEvents(ctx.db, bookingId);

      // WHEN alguém tenta executar DELETE na linha de payment_events
      const deleteAttempt = attemptPaymentEventsDelete(ctx.db, event.id);

      // THEN o banco recusa a remoção por causa da trigger append-only
      await expect(deleteAttempt).rejects.toThrow(/append-only/i);
    });

    it("AC32: deve responder 404 para a rota removida POST /bookings/:id/checkout", async () => {
      // GIVEN uma reserva pendente do usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN o cliente chama a rota antiga do Checkout Pro POST /bookings/:id/checkout
      const response = await removedCheckoutProAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 404 Not Found
      expect(response.statusCode).toBe(404);
    });
  });
});
