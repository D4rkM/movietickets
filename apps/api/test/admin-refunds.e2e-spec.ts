import { CinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import { GuestFlowApp } from "./helpers/guest-flow-app";
import {
  deletePaymentsOfSessions,
  MercadoPagoMocks,
  mercadoPagoMocks,
  readBooking,
  readPaymentEvents,
  settle,
} from "./helpers/pending-booking";
import {
  adminRefundAs,
  ageRefund,
  createAdminUser,
  createExpiredPaidBooking,
  createPaidBooking,
  createRefundCinemaFixture,
  eventsOfType,
  flagForRefundReview,
  insertRefund,
  markBookingCancelled,
  mercadoPagoAnswersRefund,
  mercadoPagoTimesOut,
  newMpRefundId,
  PaidBooking,
  readRefunds,
  reviewQueueAs,
  signUserToken,
  startRefundApp,
} from "./helpers/refund";

interface ReviewItem {
  bookingId: string;
  reviewReason: string;
  refund: { id: string; status: string } | null;
}

// Spec: docs/flows/refund/spec.md (AC20-AC23)
describe("Estorno de pagamento: fila de revisão do admin (e2e)", () => {
  let ctx: GuestFlowApp;
  let mp: MercadoPagoMocks;
  let fixture: CinemaFixture;
  let sessionId: string;
  let customer: TestUser;
  let admin: TestUser;
  let customerToken: string;
  let adminToken: string;
  const movieLabel = `Admin Refund E2E ${Date.now()}`;

  beforeAll(async () => {
    ctx = await startRefundApp();
    mp = mercadoPagoMocks(ctx.app);
    fixture = await createRefundCinemaFixture(ctx.db, movieLabel);
    [sessionId] = fixture.sessionIds;
    [customer, admin] = await Promise.all([
      createUserWithPassword(ctx.db, "refund-review-customer"),
      createAdminUser(ctx.db, "refund-review-admin"),
    ]);
    customerToken = signUserToken(ctx, customer);
    adminToken = signUserToken(ctx, admin, "admin");
  });

  beforeEach(() => {
    mp.refund.total.mockReset();
    mp.payment.get.mockReset();
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [customer, admin]);
    await ctx.close();
  });

  async function expiredPaidBooking(): Promise<PaidBooking> {
    const seatIds = await fixture.addSeats(1);
    return createExpiredPaidBooking(ctx.db, { userId: customer.id, sessionId, seatIds });
  }

  async function confirmedPaidBooking(): Promise<PaidBooking> {
    const seatIds = await fixture.addSeats(1);
    return createPaidBooking(ctx.db, { userId: customer.id, sessionId, seatIds });
  }

  async function reviewQueue(): Promise<ReviewItem[]> {
    const response = await reviewQueueAs(ctx.app, adminToken);
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  describe("GET /admin/refunds/review", () => {
    it("AC20: deve listar na fila as reservas que precisam de estorno", async () => {
      // GIVEN uma reserva expirada paga, um estorno rejeitado depois de aceito, um estorno requested parado,
      // um estorno requested recente e uma reserva confirmada normal
      const expiredPaid = await expiredPaidBooking();
      const rejectedAfterAccept = await confirmedPaidBooking();
      await insertRefund(ctx.db, rejectedAfterAccept, { status: "rejected", externalRefundId: String(newMpRefundId()) });
      await markBookingCancelled(ctx.db, rejectedAfterAccept.bookingId, ["A1"]);
      await flagForRefundReview(ctx.db, rejectedAfterAccept.bookingId);
      const stalled = await confirmedPaidBooking();
      const stalledRefund = await insertRefund(ctx.db, stalled, { status: "requested", requestedBy: customer.id });
      await ageRefund(ctx.db, stalledRefund.id, 3);
      const recent = await confirmedPaidBooking();
      await insertRefund(ctx.db, recent, { status: "requested", requestedBy: customer.id });
      const untouched = await confirmedPaidBooking();

      // WHEN o admin consulta a fila
      const queue = await reviewQueue();

      // THEN aparecem só as três que precisam de ação, com o motivo e os dados da reserva
      const byBooking = new Map(queue.map((item) => [item.bookingId, item]));
      expect(byBooking.get(expiredPaid.bookingId)).toEqual({
        bookingId: expiredPaid.bookingId,
        bookingStatus: "expired",
        customerEmail: customer.email,
        movieTitle: `${movieLabel} Movie`,
        sessionStartsAt: expect.any(String),
        amountCents: expiredPaid.amountCents,
        externalPaymentId: expiredPaid.externalPaymentId,
        paymentApprovedAt: expect.any(String),
        reviewReason: "expired_booking_paid",
        refund: null,
      });
      expect(byBooking.get(rejectedAfterAccept.bookingId)).toMatchObject({
        bookingStatus: "cancelled",
        reviewReason: "refund_rejected",
        refund: { status: "rejected", errorCode: null },
      });
      expect(byBooking.get(stalled.bookingId)).toMatchObject({
        bookingStatus: "confirmed",
        reviewReason: "refund_stalled",
        refund: { id: stalledRefund.id, status: "requested" },
      });
      expect(byBooking.has(recent.bookingId)).toBe(false);
      expect(byBooking.has(untouched.bookingId)).toBe(false);
    });

    it("AC20: deve recusar com 401 a fila sem token", async () => {
      // GIVEN nenhum token

      // WHEN alguém consulta a fila
      const response = await reviewQueueAs(ctx.app, undefined);

      // THEN recebe 401
      expect(response.statusCode).toBe(401);
    });

    it("AC20: deve recusar com 403 a fila para token de cliente", async () => {
      // GIVEN um token de cliente

      // WHEN o cliente consulta a fila
      const response = await reviewQueueAs(ctx.app, customerToken);

      // THEN recebe 403
      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /admin/bookings/:id/refund", () => {
    it("AC21: deve estornar pelo admin o pagamento aprovado em reserva expirada", async () => {
      // GIVEN uma reserva expirada paga, na fila de revisão
      const paid = await expiredPaidBooking();
      const mpRefundId = mercadoPagoAnswersRefund(mp, "approved");

      // WHEN o admin pede o estorno e o Mercado Pago aprova
      const response = await adminRefundAs(ctx.app, adminToken, paid.bookingId);

      // THEN o estorno total sai pelo mesmo serviço, com o admin como autor e source admin nos eventos
      expect(response.statusCode).toBe(200);
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(response.json()).toEqual({
        bookingId: paid.bookingId,
        bookingStatus: "expired",
        refund: { id: refund.id, status: "approved", amountCents: paid.amountCents },
      });
      expect(refund).toMatchObject({
        reason: "expired_booking_review",
        requestedBy: admin.id,
        status: "approved",
        externalRefundId: String(mpRefundId),
      });
      expect(mp.refund.total).toHaveBeenCalledWith({
        payment_id: paid.externalPaymentId,
        requestOptions: { idempotencyKey: refund.id, timeout: 15_000 },
      });
      const refundEvents = (await readPaymentEvents(ctx.db, paid.bookingId)).filter((event) =>
        event.type.startsWith("refund_"),
      );
      expect(refundEvents.map((event) => (event.payload as { source: string }).source)).toEqual([
        "admin",
        "admin",
        "admin",
      ]);
      // AND the booking stays expired, leaves the review flag and the queue
      expect(await readBooking(ctx.db, paid.bookingId)).toMatchObject({ status: "expired", needsRefundReview: false });
      expect((await reviewQueue()).map((item) => item.bookingId)).not.toContain(paid.bookingId);
    });

    it("AC22: deve recusar estorno de reserva fora da fila", async () => {
      // GIVEN uma reserva confirmada e paga, sem marca de revisão nem estorno parado
      const paid = await confirmedPaidBooking();

      // WHEN o admin pede o estorno
      const response = await adminRefundAs(ctx.app, adminToken, paid.bookingId);

      // THEN recebe 409 REFUND_NOT_ALLOWED sem chamar o Mercado Pago
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "REFUND_NOT_ALLOWED" });
      expect(mp.refund.total).not.toHaveBeenCalled();
    });

    it("AC22: deve reconciliar o estorno em processamento em vez de criar outro", async () => {
      // GIVEN uma reserva expirada em revisão cujo estorno está in_process no Mercado Pago
      const paid = await expiredPaidBooking();
      const mpRefundId = newMpRefundId();
      const inProcess = await insertRefund(ctx.db, paid, {
        status: "in_process",
        reason: "expired_booking_review",
        externalRefundId: String(mpRefundId),
        requestedBy: admin.id,
      });
      mp.payment.get.mockResolvedValue({
        id: Number(paid.externalPaymentId),
        status: "refunded",
        refunds: [{ id: mpRefundId, status: "approved" }],
      });

      // WHEN o admin aciona "Atualizar status"
      const response = await adminRefundAs(ctx.app, adminToken, paid.bookingId);

      // THEN re-busca o pagamento, aplica o status encontrado e não cria estorno novo
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ refund: { id: inProcess.id, status: "approved" } });
      expect(mp.payment.get).toHaveBeenCalledWith({ id: Number(paid.externalPaymentId) });
      expect(mp.refund.total).not.toHaveBeenCalled();
      expect(await readRefunds(ctx.db, paid.bookingId)).toHaveLength(1);
      expect((await readBooking(ctx.db, paid.bookingId)).needsRefundReview).toBe(false);
    });

    it("AC22: deve tentar de novo com a mesma chave o estorno requested parado", async () => {
      // GIVEN um cancelamento do cliente cujo estorno ficou requested parado há mais de 2 minutos
      const paid = await confirmedPaidBooking();
      const stalled = await insertRefund(ctx.db, paid, { status: "requested", requestedBy: customer.id });
      await ageRefund(ctx.db, stalled.id, 3);
      mercadoPagoAnswersRefund(mp, "approved");

      // WHEN o admin aciona o estorno
      const response = await adminRefundAs(ctx.app, adminToken, paid.bookingId);

      // THEN a chamada usa a mesma chave, mantém o motivo original e conclui o cancelamento
      expect(response.statusCode).toBe(200);
      expect(mp.refund.total.mock.calls[0][0].requestOptions.idempotencyKey).toBe(stalled.id);
      const refunds = await readRefunds(ctx.db, paid.bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ status: "approved", reason: "customer_cancellation" });
      expect((await readBooking(ctx.db, paid.bookingId)).status).toBe("cancelled");
    });

    it("AC22: deve responder com os mesmos códigos do cliente quando o Mercado Pago não responde", async () => {
      // GIVEN uma reserva expirada paga, na fila
      const paid = await expiredPaidBooking();
      mercadoPagoTimesOut(mp);

      // WHEN o admin pede o estorno e o Mercado Pago não responde
      const response = await adminRefundAs(ctx.app, adminToken, paid.bookingId);

      // THEN recebe 504 REFUND_PROVIDER_TIMEOUT e o pedido continua requested
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ code: "REFUND_PROVIDER_TIMEOUT" });
      const [refund] = await readRefunds(ctx.db, paid.bookingId);
      expect(refund.status).toBe("requested");
    });

    it("AC23: deve chamar o Mercado Pago uma única vez com dois estornos simultâneos do admin", async () => {
      // GIVEN uma reserva expirada paga e um Mercado Pago que demora a responder
      const paid = await expiredPaidBooking();
      mp.refund.total.mockImplementation(async () => {
        await settle(200);
        return { id: newMpRefundId(), status: "approved" };
      });

      // WHEN dois pedidos de estorno chegam ao mesmo tempo
      const responses = await Promise.all([
        adminRefundAs(ctx.app, adminToken, paid.bookingId),
        adminRefundAs(ctx.app, adminToken, paid.bookingId),
      ]);

      // THEN o Mercado Pago é chamado uma vez e há um único estorno
      expect(mp.refund.total).toHaveBeenCalledTimes(1);
      expect(await readRefunds(ctx.db, paid.bookingId)).toHaveLength(1);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(eventsOfType(await readPaymentEvents(ctx.db, paid.bookingId), "refund_confirmed")).toHaveLength(1);
    });
  });
});
