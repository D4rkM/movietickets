import { NotificationService } from "../src/notification/notification.service";
import { BookingService } from "../src/booking/booking.service";
import { CinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import { clearSessionHolds, watchSessionAs } from "./helpers/guest-flow";
import { GuestFlowApp } from "./helpers/guest-flow-app";
import { countMailpitMessages, findMailpitMessage } from "./helpers/mailpit";
import {
  bookSeatsAs,
  captureWarnings,
  deletePaymentsOfSessions,
  insertBooking,
  MercadoPagoMocks,
  mercadoPagoMocks,
  readBooking,
  readPaymentAttempt,
  readPaymentEvents,
  seatIdsOf,
  settle,
} from "./helpers/pending-booking";
import {
  ageRefund,
  cancelAs,
  createExpiredPaidBooking,
  createPaidBooking,
  cancelledSeatLabelsColumn,
  createRefundCinemaFixture,
  deliverRefundWebhook,
  eventsOfType,
  eventTypes,
  insertRefund,
  mercadoPagoAnswersRefund,
  mercadoPagoRefusesRefund,
  mercadoPagoTimesOut,
  myBookingsAs,
  newMpRefundId,
  readMigrationSql,
  readRefunds,
  refundIndexDefinitions,
  seatLabelsOf,
  seatStatusesSeenBy,
  signUserToken,
  startRefundApp,
} from "./helpers/refund";

// Spec: docs/flows/refund/spec.md (AC1-AC19, AC24, AC26, AC31, AC32)
describe("Estorno de pagamento: cancelamento pelo cliente e webhook (e2e)", () => {
  let ctx: GuestFlowApp;
  let mp: MercadoPagoMocks;
  let fixture: CinemaFixture;
  const fixtureLabel = `Refund E2E ${Date.now()}`;
  let sessionId: string;
  let nearSessionId: string;
  let owner: TestUser;
  let otherUser: TestUser;
  let ownerToken: string;
  let otherUserToken: string;

  beforeAll(async () => {
    ctx = await startRefundApp();
    mp = mercadoPagoMocks(ctx.app);
    fixture = await createRefundCinemaFixture(ctx.db, fixtureLabel);
    [sessionId, nearSessionId] = fixture.sessionIds;
    [owner, otherUser] = await Promise.all([
      createUserWithPassword(ctx.db, "refund-owner"),
      createUserWithPassword(ctx.db, "refund-other"),
    ]);
    [ownerToken, otherUserToken] = [signUserToken(ctx, owner), signUserToken(ctx, otherUser)];
  });

  beforeEach(() => {
    mp.refund.total.mockReset();
    mp.payment.get.mockReset();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [owner, otherUser]);
    await ctx.close();
  });

  function paidBookingOfOwner(seatCount = 1, targetSessionId = sessionId) {
    return fixture
      .addSeats(seatCount)
      .then((seatIds) => createPaidBooking(ctx.db, { userId: owner.id, sessionId: targetSessionId, seatIds }));
  }

  describe("POST /bookings/:id/cancel", () => {
    it("AC1: deve registrar o pedido de estorno antes de chamar o Mercado Pago", async () => {
      // GIVEN uma reserva confirmada e paga do usuário, dentro do prazo
      const paid = await paidBookingOfOwner(2);
      let stateSeenByMercadoPago: { refunds: Awaited<ReturnType<typeof readRefunds>>; events: string[] } | undefined;
      mp.refund.total.mockImplementation(async () => {
        stateSeenByMercadoPago = {
          refunds: await readRefunds(ctx.db, paid.bookingId),
          events: eventTypes(await readPaymentEvents(ctx.db, paid.bookingId)),
        };
        return { id: newMpRefundId(), status: "approved" };
      });

      // WHEN o usuário cancela o ingresso
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN no momento da chamada o pedido já estava gravado e a chamada é um estorno total com a chave = refunds.id
      expect(stateSeenByMercadoPago?.refunds).toHaveLength(1);
      const [refund] = stateSeenByMercadoPago!.refunds;
      expect(refund).toMatchObject({
        status: "requested",
        reason: "customer_cancellation",
        amountCents: paid.amountCents,
        paymentId: paid.paymentId,
        requestedBy: owner.id,
      });
      expect(stateSeenByMercadoPago?.events).toEqual(["refund_requested"]);
      expect(mp.refund.total).toHaveBeenCalledTimes(1);
      const [call] = mp.refund.total.mock.calls[0];
      expect(call).toEqual({
        payment_id: paid.externalPaymentId,
        requestOptions: { idempotencyKey: refund.id, timeout: 15_000 },
      });
      expect(call).not.toHaveProperty("body");
    });

    it("AC2: deve cancelar o ingresso, liberar os assentos e concluir o estorno aprovado", async () => {
      // GIVEN uma reserva paga com dois assentos e alguém olhando o mapa da sessão
      const paid = await paidBookingOfOwner(2);
      const seatLabels = await seatLabelsOf(ctx.db, paid.seatIds);
      const watcher = await watchSessionAs(ctx.baseUrl, otherUserToken, sessionId);
      const mpRefundId = mercadoPagoAnswersRefund(mp, "approved");

      // WHEN o usuário cancela e o Mercado Pago aprova o estorno
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN responde cancelado com estorno concluído e libera os assentos em tempo real
      expect(response.statusCode).toBe(200);
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(response.json()).toEqual({
        bookingId: paid.bookingId,
        status: "cancelled",
        refund: { id: refund.id, status: "completed", amountCents: paid.amountCents },
      });
      const booking = await readBooking(ctx.db, paid.bookingId);
      expect(booking.status).toBe("cancelled");
      expect(booking.cancelledSeatLabels).toEqual(seatLabels);
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual([]);
      expect(refund).toMatchObject({ status: "approved", externalRefundId: String(mpRefundId) });
      const events = eventTypes(await readPaymentEvents(ctx.db, paid.bookingId));
      expect(events).toEqual(expect.arrayContaining(["refund_response", "refund_confirmed", "booking_cancelled"]));
      for (const seatId of paid.seatIds) {
        await watcher.waitFor((update) => update.seatId === seatId && update.status === "released");
      }
      watcher.close();
    });

    it("AC3: deve permitir que outra pessoa reserve o assento de um ingresso cancelado", async () => {
      // GIVEN um ingresso pago cancelado com estorno aprovado
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "approved");
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // WHEN outro usuário olha o mapa e reserva o mesmo assento
      const statusBefore = await seatStatusesSeenBy(ctx.app, otherUserToken, sessionId, paid.seatIds);
      const response = await bookSeatsAs(ctx.app, otherUserToken, sessionId, paid.seatIds);

      // THEN o assento aparecia livre e a reserva é criada
      expect(statusBefore).toEqual(["free"]);
      expect(response.statusCode).toBe(201);
    });

    it("AC4: deve cancelar o ingresso com estorno em processamento", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "in_process");

      // WHEN o usuário cancela e o Mercado Pago responde o estorno em processamento
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN a reserva fica cancelada, os assentos liberados e o estorno aparece pendente
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "cancelled", refund: { status: "pending" } });
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual([]);
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("in_process");
    });

    it("AC5: deve recusar cancelamento a menos de 2 horas da sessão", async () => {
      // GIVEN uma reserva paga de uma sessão que começa em 2 horas (relógio do banco)
      const paid = await paidBookingOfOwner(1, nearSessionId);

      // WHEN o usuário tenta cancelar
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 409 CANCELLATION_DEADLINE_PASSED sem chamar o Mercado Pago nem mudar nada
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "CANCELLATION_DEADLINE_PASSED" });
      expect(mp.refund.total).not.toHaveBeenCalled();
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toHaveLength(1);
      expect(await readRefunds(ctx.db, paid.bookingId)).toEqual([]);
    });

    it("AC6: deve cancelar sem estorno o ingresso confirmado sem pagamento", async () => {
      // GIVEN uma reserva confirmada sem pagamento aprovado (confirmação mock)
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId], status: "confirmed" });

      // WHEN o usuário cancela
      const response = await cancelAs(ctx.app, ownerToken, bookingId);

      // THEN cancela e libera o assento sem chamar o Mercado Pago, com booking_cancelled gravado
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ bookingId, status: "cancelled", refund: null });
      expect(mp.refund.total).not.toHaveBeenCalled();
      expect(await seatIdsOf(ctx.db, bookingId)).toEqual([]);
      const [cancelledEvent] = eventsOfType(await readPaymentEvents(ctx.db, bookingId), "booking_cancelled");
      expect(cancelledEvent.paymentId).toBeNull();
    });

    it("AC7: deve responder 404 ao cancelar reserva de outro usuário", async () => {
      // GIVEN uma reserva paga do dono
      const paid = await paidBookingOfOwner(1);

      // WHEN outro usuário tenta cancelar
      const response = await cancelAs(ctx.app, otherUserToken, paid.bookingId);

      // THEN recebe 404
      expect(response.statusCode).toBe(404);
      expect(mp.refund.total).not.toHaveBeenCalled();
    });

    it("AC7: deve responder 409 BOOKING_NOT_CANCELLABLE ao cancelar reserva pendente", async () => {
      // GIVEN uma reserva pendente do usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId] });

      // WHEN o usuário tenta cancelar
      const response = await cancelAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 BOOKING_NOT_CANCELLABLE
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    });

    it("AC7: deve responder 409 BOOKING_NOT_CANCELLABLE ao cancelar reserva expirada", async () => {
      // GIVEN uma reserva expirada do usuário
      const [seatId] = await fixture.addSeats(1);
      const bookingId = await insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds: [seatId], status: "expired" });

      // WHEN o usuário tenta cancelar
      const response = await cancelAs(ctx.app, ownerToken, bookingId);

      // THEN recebe 409 BOOKING_NOT_CANCELLABLE
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    });

    it("AC8: deve devolver o estado atual ao cancelar de novo um ingresso já cancelado", async () => {
      // GIVEN um ingresso já cancelado com estorno aprovado
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "approved");
      const first = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // WHEN o usuário cancela de novo
      const second = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 200 com o mesmo estado, sem nova chamada nem nova linha de estorno
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(mp.refund.total).toHaveBeenCalledTimes(1);
      expect(await readRefunds(ctx.db, paid.bookingId)).toHaveLength(1);
    });

    it("AC9: deve manter o ingresso válido quando o Mercado Pago recusa o pedido de estorno", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoRefusesRefund(mp, 400, 2063);

      // WHEN o usuário cancela e o Mercado Pago recusa a requisição com 4xx
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 422 REFUND_REQUEST_INVALID, o estorno fica failed e o ingresso continua válido
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "REFUND_REQUEST_INVALID" });
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund).toMatchObject({ status: "failed", errorCode: "2063" });
      expect(eventsOfType(await readPaymentEvents(ctx.db, paid.bookingId), "refund_request_failed")).toHaveLength(1);
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual(paid.seatIds);
    });

    it("AC9: deve criar um novo pedido de estorno depois de uma falha", async () => {
      // GIVEN um cancelamento que falhou com 4xx
      const paid = await paidBookingOfOwner(1);
      mercadoPagoRefusesRefund(mp, 400, 2063);
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // WHEN o usuário cancela de novo e desta vez o Mercado Pago aprova
      mercadoPagoAnswersRefund(mp, "approved");
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN há uma nova linha de estorno e a segunda chamada usou uma chave nova
      expect(response.statusCode).toBe(200);
      const refunds = await readRefunds(ctx.db, paid.bookingId);
      expect(refunds.map((refund) => refund.status)).toEqual(["failed", "approved"]);
      const keys = mp.refund.total.mock.calls.map(([call]) => call.requestOptions.idempotencyKey);
      expect(keys).toEqual([refunds[0].id, refunds[1].id]);
    });

    it("AC10: deve manter o ingresso válido quando o estorno é rejeitado", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "rejected");

      // WHEN o usuário cancela e o Mercado Pago responde o estorno rejeitado
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 422 REFUND_REJECTED e a reserva continua confirmada com os assentos
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "REFUND_REJECTED" });
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("rejected");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual(paid.seatIds);
    });

    it("AC11: deve responder 504 e manter o pedido quando o Mercado Pago não responde", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoTimesOut(mp);

      // WHEN o usuário cancela e o Mercado Pago não responde
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 504 REFUND_PROVIDER_TIMEOUT, o estorno continua requested e a reserva confirmed
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ code: "REFUND_PROVIDER_TIMEOUT" });
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("requested");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
    });

    it("AC11: deve responder estorno em andamento ao tentar de novo antes de 2 minutos", async () => {
      // GIVEN um cancelamento que ficou sem resposta agora há pouco
      const paid = await paidBookingOfOwner(1);
      mercadoPagoTimesOut(mp);
      await cancelAs(ctx.app, ownerToken, paid.bookingId);
      mp.refund.total.mockClear();

      // WHEN o usuário tenta de novo antes de 2 minutos
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 409 REFUND_IN_PROGRESS sem chamar o Mercado Pago
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "REFUND_IN_PROGRESS" });
      expect(mp.refund.total).not.toHaveBeenCalled();
    });

    it("AC11: deve tentar de novo com a mesma chave depois de 2 minutos", async () => {
      // GIVEN um cancelamento sem resposta há mais de 2 minutos
      const paid = await paidBookingOfOwner(1);
      mercadoPagoTimesOut(mp);
      await cancelAs(ctx.app, ownerToken, paid.bookingId);
      const [stalled] = await readRefunds(ctx.db, paid.bookingId);
      await ageRefund(ctx.db, stalled.id, 3);

      // WHEN o usuário tenta de novo e o Mercado Pago aprova
      mercadoPagoAnswersRefund(mp, "approved");
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN a nova chamada usa a mesma chave e não cria outra linha
      expect(response.statusCode).toBe(200);
      const keys = mp.refund.total.mock.calls.map(([call]) => call.requestOptions.idempotencyKey);
      expect(keys).toEqual([stalled.id, stalled.id]);
      const refunds = await readRefunds(ctx.db, paid.bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe("approved");
    });

    it("AC12: deve chamar o Mercado Pago uma única vez com dois cancelamentos simultâneos", async () => {
      // GIVEN uma reserva paga e um Mercado Pago que demora a responder
      const paid = await paidBookingOfOwner(1);
      mp.refund.total.mockImplementation(async () => {
        await settle(200);
        return { id: newMpRefundId(), status: "approved" };
      });

      // WHEN o usuário dispara dois cancelamentos ao mesmo tempo
      const responses = await Promise.all([
        cancelAs(ctx.app, ownerToken, paid.bookingId),
        cancelAs(ctx.app, ownerToken, paid.bookingId),
      ]);

      // THEN o Mercado Pago é chamado uma vez, há uma linha só e o outro recebe 409 ou o replay 200
      expect(mp.refund.total).toHaveBeenCalledTimes(1);
      expect(await readRefunds(ctx.db, paid.bookingId)).toHaveLength(1);
      const statuses = responses.map((response) => response.statusCode).sort();
      expect([[200, 200], [200, 409]]).toContainEqual(statuses);
      const loser = responses.find((response) => response.statusCode === 409);
      if (loser) expect(loser.json()).toMatchObject({ code: "REFUND_IN_PROGRESS" });
    });

    it("AC12: deve responder estorno em andamento quando o Mercado Pago ainda processa a mesma chave", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoRefusesRefund(mp, 409);

      // WHEN o usuário cancela e o Mercado Pago responde 409 (mesma chave em processamento)
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN recebe 409 REFUND_IN_PROGRESS e nada muda além do pedido registrado
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "REFUND_IN_PROGRESS" });
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("requested");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
    });

    it("AC13: deve impedir no banco dois estornos ativos para o mesmo pagamento", async () => {
      // GIVEN um pagamento que já tem um estorno em processamento
      const paid = await paidBookingOfOwner(1);
      await insertRefund(ctx.db, paid, { status: "in_process", externalRefundId: String(newMpRefundId()) });

      // WHEN alguém insere direto no banco um segundo estorno requested do mesmo pagamento
      const secondInsert = insertRefund(ctx.db, paid, { status: "requested" });

      // THEN o banco recusa pela unicidade parcial
      await expect(secondInsert).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "23505", constraint_name: "refunds_active_per_payment_uq" }),
      });
    });
  });

  describe("POST /payments/webhook com estorno", () => {
    it("AC14: deve concluir pelo webhook o estorno em processamento", async () => {
      // GIVEN um ingresso cancelado com estorno in_process
      const paid = await paidBookingOfOwner(1);
      const mpRefundId = mercadoPagoAnswersRefund(mp, "in_process");
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // WHEN chega o webhook do pagamento refunded com o estorno aprovado
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);

      // THEN o estorno fica approved, com refund_confirmed, e a tentativa vira refunded
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund).toMatchObject({ status: "approved", externalRefundId: String(mpRefundId) });
      expect(eventsOfType(await readPaymentEvents(ctx.db, paid.bookingId), "refund_confirmed")).toHaveLength(1);
      expect((await readPaymentAttempt(ctx.db, paid.paymentId))?.status).toBe("refunded");
    });

    it("AC14: deve cancelar a reserva pelo webhook quando a resposta síncrona se perdeu", async () => {
      // GIVEN um pedido de estorno requested sem resposta e a reserva ainda confirmada
      const paid = await paidBookingOfOwner(2);
      await insertRefund(ctx.db, paid, { status: "requested", requestedBy: owner.id });
      const watcher = await watchSessionAs(ctx.baseUrl, otherUserToken, sessionId);
      const mpRefundId = newMpRefundId();

      // WHEN chega o webhook do pagamento refunded
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);

      // THEN o estorno é concluído com o id do Mercado Pago e a reserva é cancelada com os assentos liberados
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund).toMatchObject({ status: "approved", externalRefundId: String(mpRefundId) });
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual([]);
      for (const seatId of paid.seatIds) {
        await watcher.waitFor((update) => update.seatId === seatId && update.status === "released");
      }
      watcher.close();
    });

    it("AC15: deve ignorar webhook de estorno repetido", async () => {
      // GIVEN um estorno já concluído por um primeiro webhook
      const paid = await paidBookingOfOwner(1);
      await insertRefund(ctx.db, paid, { status: "requested", requestedBy: owner.id });
      const mpRefundId = newMpRefundId();
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);
      const watcher = await watchSessionAs(ctx.baseUrl, otherUserToken, sessionId);

      // WHEN o mesmo webhook chega de novo
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);
      await settle();

      // THEN só um novo webhook_received é gravado: nenhum refund_confirmed extra, broadcast ou e-mail
      const events = await readPaymentEvents(ctx.db, paid.bookingId);
      expect(eventsOfType(events, "refund_confirmed")).toHaveLength(1);
      expect(eventsOfType(events, "webhook_received")).toHaveLength(2);
      expect(watcher.updates).toEqual([]);
      expect(await countMailpitMessages(paid.bookingId)).toBe(0);
      watcher.close();
    });

    it("AC16: deve concluir o estorno uma única vez com webhook e resposta síncrona simultâneos", async () => {
      // GIVEN uma reserva paga e um Mercado Pago que notifica o webhook enquanto responde a chamada síncrona
      const paid = await paidBookingOfOwner(1);
      const mpRefundId = newMpRefundId();
      let webhookDelivery: Promise<void> | undefined;
      mp.refund.total.mockImplementation(async () => {
        webhookDelivery = deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);
        return { id: mpRefundId, status: "approved" };
      });

      // WHEN o usuário cancela e as duas confirmações chegam ao mesmo tempo
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);
      await webhookDelivery;

      // THEN o estorno termina approved com uma única transição e um único refund_confirmed
      expect(response.statusCode).toBe(200);
      const refunds = await readRefunds(ctx.db, paid.bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe("approved");
      const events = await readPaymentEvents(ctx.db, paid.bookingId);
      expect(eventsOfType(events, "refund_confirmed")).toHaveLength(1);
      expect(eventsOfType(events, "booking_cancelled")).toHaveLength(1);
    });

    it("AC17: deve cancelar a reserva confirmada quando o estorno foi feito no painel do Mercado Pago", async () => {
      // GIVEN uma reserva confirmada e paga sem nenhum estorno pedido pela API
      const paid = await paidBookingOfOwner(1);
      const warnings = captureWarnings();
      const mpRefundId = newMpRefundId();

      // WHEN chega o webhook do pagamento refunded
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: mpRefundId, status: "approved" }]);

      // THEN registra um estorno external approved, loga warn e cancela a reserva liberando os assentos
      warnings.restore();
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund).toMatchObject({
        reason: "external",
        status: "approved",
        externalRefundId: String(mpRefundId),
        requestedBy: null,
        amountCents: paid.amountCents,
      });
      expect(warnings.mentioning(paid.bookingId).some((message) => message.includes("external"))).toBe(true);
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
      expect(await seatIdsOf(ctx.db, paid.bookingId)).toEqual([]);
      expect(await countMailpitMessages(paid.bookingId)).toBe(0);
    });

    it("AC17: deve limpar a revisão da reserva expirada quando o estorno foi feito no painel do Mercado Pago", async () => {
      // GIVEN uma reserva expirada com pagamento aprovado marcada para revisão
      const seatIds = await fixture.addSeats(1);
      const paid = await createExpiredPaidBooking(ctx.db, { userId: owner.id, sessionId, seatIds });
      const warnings = captureWarnings();

      // WHEN chega o webhook do pagamento refunded
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: newMpRefundId(), status: "approved" }]);

      // THEN registra o estorno external e a reserva continua expired, sem a marca de revisão
      warnings.restore();
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund).toMatchObject({ reason: "external", status: "approved" });
      const booking = await readBooking(ctx.db, paid.bookingId);
      expect(booking).toMatchObject({ status: "expired", needsRefundReview: false });
    });

    it("AC18: deve mandar para revisão o estorno rejeitado depois de aceito", async () => {
      // GIVEN um ingresso cancelado com estorno in_process
      const paid = await paidBookingOfOwner(1);
      const mpRefundId = mercadoPagoAnswersRefund(mp, "in_process");
      await cancelAs(ctx.app, ownerToken, paid.bookingId);
      const warnings = captureWarnings();

      // WHEN chega o webhook mostrando o pagamento ainda aprovado com o estorno rejeitado
      await deliverRefundWebhook(ctx.app, mp, paid, "approved", [{ id: mpRefundId, status: "rejected" }]);

      // THEN o estorno vira rejected, a reserva (ainda cancelada) vai para revisão e há log warn
      warnings.restore();
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("rejected");
      expect(await readBooking(ctx.db, paid.bookingId)).toMatchObject({ status: "cancelled", needsRefundReview: true });
      expect(warnings.mentioning(paid.bookingId)).toHaveLength(1);
    });

    it("AC19: deve só registrar o status charged_back sem mudar reserva nem estornos", async () => {
      // GIVEN uma reserva confirmada e paga
      const paid = await paidBookingOfOwner(1);
      const warnings = captureWarnings();

      // WHEN chega o webhook do pagamento charged_back
      await deliverRefundWebhook(ctx.app, mp, paid, "charged_back", []);

      // THEN grava o status da tentativa, mantém a reserva e loga warn
      warnings.restore();
      expect((await readPaymentAttempt(ctx.db, paid.paymentId))?.status).toBe("charged_back");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
      expect(await readRefunds(ctx.db, paid.bookingId)).toEqual([]);
      expect(warnings.mentioning(paid.bookingId)).toHaveLength(1);
    });

    it("AC19: deve só registrar o status in_mediation sem mudar reserva nem estornos", async () => {
      // GIVEN uma reserva confirmada e paga
      const paid = await paidBookingOfOwner(1);
      const warnings = captureWarnings();

      // WHEN chega o webhook do pagamento in_mediation
      await deliverRefundWebhook(ctx.app, mp, paid, "in_mediation", []);

      // THEN grava o status da tentativa, mantém a reserva e loga warn
      warnings.restore();
      expect((await readPaymentAttempt(ctx.db, paid.paymentId))?.status).toBe("in_mediation");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
      expect(await readRefunds(ctx.db, paid.bookingId)).toEqual([]);
      expect(warnings.mentioning(paid.bookingId)).toHaveLength(1);
    });
  });

  describe("Auditoria", () => {
    it("AC24: deve registrar o histórico completo de um cancelamento com estorno", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "approved");

      // WHEN o usuário cancela e o estorno é aprovado
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN os eventos saem na ordem, todos ligados à tentativa estornada
      const events = await readPaymentEvents(ctx.db, paid.bookingId);
      expect(eventTypes(events)).toEqual(["refund_requested", "refund_response", "refund_confirmed", "booking_cancelled"]);
      expect(events.every((event) => event.paymentId === paid.paymentId)).toBe(true);
    });

    it("AC24: não deve deixar evento quando a transação falha", async () => {
      // GIVEN uma reserva paga e uma falha forçada dentro da tx2
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "approved");
      jest
        .spyOn(ctx.app.get(BookingService), "cancelConfirmedBooking")
        .mockRejectedValueOnce(new Error("Simulated failure inside tx2"));

      // WHEN o usuário cancela
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN a tx2 é desfeita inteira: só o refund_requested da tx1 fica gravado
      expect(response.statusCode).toBe(500);
      expect(eventTypes(await readPaymentEvents(ctx.db, paid.bookingId))).toEqual(["refund_requested"]);
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("requested");
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("confirmed");
    });
  });

  describe("GET /bookings/mine", () => {
    it("AC26: deve listar em Meus ingressos o ingresso cancelado com o status do estorno", async () => {
      // GIVEN um ingresso cancelado com estorno em processamento, um ingresso confirmado e um cancelado sem pagamento
      const cancelledPaid = await paidBookingOfOwner(2);
      const seatLabels = await seatLabelsOf(ctx.db, cancelledPaid.seatIds);
      mercadoPagoAnswersRefund(mp, "in_process");
      await cancelAs(ctx.app, ownerToken, cancelledPaid.bookingId);
      const confirmed = await paidBookingOfOwner(1);
      const [unpaidSeatId] = await fixture.addSeats(1);
      const unpaidBookingId = await insertBooking(ctx.db, {
        userId: owner.id,
        sessionId,
        seatIds: [unpaidSeatId],
        status: "confirmed",
      });
      await cancelAs(ctx.app, ownerToken, unpaidBookingId);

      // WHEN o usuário lista os seus ingressos
      const response = await myBookingsAs(ctx.app, ownerToken);

      // THEN o cancelado aparece com assentos do snapshot, valor, prazo e estorno pendente; o sem pagamento não aparece
      expect(response.statusCode).toBe(200);
      const body: { bookingId: string }[] = response.json();
      const cancelledEntry = body.find((entry) => entry.bookingId === cancelledPaid.bookingId);
      const [refund] = await readRefunds(ctx.db, cancelledPaid.bookingId);
      expect(cancelledEntry).toMatchObject({
        status: "cancelled",
        seats: seatLabels.map((label) => ({ rowLabel: label[0], seatNumber: Number(label.slice(1)) })),
        amountCents: cancelledPaid.amountCents,
        refund: { status: "pending", amountCents: cancelledPaid.amountCents, requestedAt: refund.createdAt.toISOString() },
      });
      const confirmedEntry = body.find((entry) => entry.bookingId === confirmed.bookingId) as unknown as {
        session: { startsAt: string };
        cancellableUntil: string;
      };
      expect(confirmedEntry).toMatchObject({ status: "confirmed", amountCents: confirmed.amountCents, refund: null });
      expect(Date.parse(confirmedEntry.session.startsAt) - Date.parse(confirmedEntry.cancellableUntil)).toBe(2 * 60 * 60 * 1000);
      expect(body.map((entry) => entry.bookingId)).not.toContain(unpaidBookingId);
    });
  });

  describe("E-mail de estorno", () => {
    it("AC31: deve enviar e-mail de estorno solicitado", async () => {
      // GIVEN uma reserva paga
      const paid = await paidBookingOfOwner(2);
      mercadoPagoAnswersRefund(mp, "in_process");

      // WHEN o usuário cancela e o estorno é aceito
      await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN o dono recebe o e-mail de estorno solicitado
      const message = await findMailpitMessage(paid.bookingId);
      expect(message.Subject).toBe(`Estorno solicitado: ${fixtureLabel} Movie`);
      expect(message.To.map((recipient) => recipient.Address)).toEqual([owner.email]);
    });

    it("AC31: não deve falhar o cancelamento quando o e-mail falha", async () => {
      // GIVEN uma reserva paga e o SMTP fora do ar
      const paid = await paidBookingOfOwner(1);
      mercadoPagoAnswersRefund(mp, "approved");
      jest
        .spyOn(ctx.app.get(NotificationService), "sendRefundRequestedEmail")
        .mockRejectedValueOnce(new Error("SMTP down"));
      const warnings = captureWarnings();

      // WHEN o usuário cancela
      const response = await cancelAs(ctx.app, ownerToken, paid.bookingId);

      // THEN o cancelamento conclui normalmente e só um warn é logado
      warnings.restore();
      expect(response.statusCode).toBe(200);
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
      expect(warnings.mentioning(paid.bookingId)).toHaveLength(1);
    });

    it("AC31: não deve enviar e-mail quando o estorno conclui pelo webhook", async () => {
      // GIVEN um pedido de estorno requested sem resposta síncrona
      const paid = await paidBookingOfOwner(1);
      await insertRefund(ctx.db, paid, { status: "requested", requestedBy: owner.id });

      // WHEN o estorno é concluído pelo webhook
      await deliverRefundWebhook(ctx.app, mp, paid, "refunded", [{ id: newMpRefundId(), status: "approved" }]);
      await settle(300);

      // THEN nenhum e-mail de estorno é enviado
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
      expect(await countMailpitMessages(paid.bookingId)).toBe(0);
    });
  });

  describe("Migration", () => {
    it("AC32: deve criar a tabela de estornos sem alterar dados existentes", async () => {
      // GIVEN o banco com as migrations aplicadas

      // WHEN olhamos os índices de refunds, a coluna nova de bookings e o SQL da migration 0005
      const indexes = await refundIndexDefinitions(ctx.db);
      const column = await cancelledSeatLabelsColumn(ctx.db);
      const migrationSql = readMigrationSql("0005_");

      // THEN há os índices únicos parciais, a coluna nova é opcional sem default e a migration não reescreve dados
      expect(indexes.get("refunds_active_per_payment_uq")).toMatch(
        /UNIQUE INDEX .*\(payment_id\) WHERE .*'requested'.*'in_process'.*'approved'/,
      );
      expect(indexes.get("refunds_external_refund_id_uq")).toMatch(
        /UNIQUE INDEX .*\(external_refund_id\) WHERE .*IS NOT NULL/,
      );
      expect(indexes.has("refunds_booking_id_idx")).toBe(true);
      expect(column).toEqual({ dataType: "ARRAY", isNullable: "YES", columnDefault: null });
      const statements = migrationSql.split("--> statement-breakpoint").map((statement) => statement.trim());
      expect(statements.filter((statement) => /^(UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(statement))).toEqual([]);
      expect(statements.filter((statement) => statement.startsWith("ALTER TABLE \"bookings\""))).toEqual([
        'ALTER TABLE "bookings" ADD COLUMN "cancelled_seat_labels" text[];',
      ]);
    });
  });
});
