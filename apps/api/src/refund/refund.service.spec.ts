import { Logger, NotFoundException } from "@nestjs/common";
import { createFakeDb, FakeDb, postgresError } from "../../test/helpers/fake-db";
import { BookingService } from "../booking/booking.service";
import * as schema from "../db/schema";
import { NotificationService } from "../notification/notification.service";
import {
  BookingNotCancellableException,
  CancellationDeadlinePassedException,
  RefundInProgressException,
  RefundNotAllowedException,
  RefundProviderTimeoutException,
  RefundRejectedException,
  RefundRequestInvalidException,
} from "./refund.exceptions";
import { RefundService } from "./refund.service";

const HOUR_MS = 60 * 60 * 1000;
const dbNow = new Date("2026-11-20T12:00:00.000Z");
const sessionInFiveHours = new Date(dbNow.getTime() + 5 * HOUR_MS);

function refundRow(overrides: Partial<schema.Refund> = {}): schema.Refund {
  return {
    id: "refund-1",
    bookingId: "booking-1",
    paymentId: "payment-1",
    externalRefundId: null,
    status: "requested",
    amountCents: 5000,
    reason: "customer_cancellation",
    requestedBy: "user-1",
    errorCode: null,
    createdAt: dbNow,
    updatedAt: dbNow,
    ...overrides,
  };
}

const confirmedBooking = { id: "booking-1", userId: "user-1", status: "confirmed", startsAt: sessionInFiveHours, dbNow };
const approvedPayment = { id: "payment-1", externalPaymentId: "4242", amountCents: 5000 };

describe("RefundService", () => {
  let db: FakeDb;
  let service: RefundService;
  let warnSpy: jest.SpyInstance;
  const refundClient = { total: jest.fn() };
  const paymentClient = { get: jest.fn() };
  const cancellationNotify = jest.fn();
  const bookingService = { cancelConfirmedBooking: jest.fn() };
  const notificationService = { sendRefundRequestedEmail: jest.fn() };

  /** Types of the payment_events rows inserted so far, in order. */
  function insertedEventTypes(): string[] {
    return db.calls
      .filter((call) => call.method === "values")
      .map((call) => (call.args[0] as { type?: string }).type)
      .filter((type): type is string => typeof type === "string");
  }

  beforeEach(() => {
    jest.clearAllMocks();
    db = createFakeDb();
    db.query.bookings = { findFirst: jest.fn(), findMany: jest.fn() };
    db.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      cancelledSeatLabels: ["A1", "A2"],
      user: { email: "cliente@test.com" },
      session: {
        startsAt: sessionInFiveHours,
        movie: { title: "Dune" },
        room: { name: "Sala 1", cinema: { name: "Cine Centro" } },
      },
    });
    bookingService.cancelConfirmedBooking.mockResolvedValue({
      cancelled: true,
      seatLabels: ["A1", "A2"],
      releasedSeatIds: ["seat-1", "seat-2"],
      notify: cancellationNotify,
    });
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    service = new RefundService(
      db as never,
      refundClient as never,
      paymentClient as never,
      bookingService as unknown as BookingService,
      notificationService as unknown as NotificationService,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("cancelWithRefund", () => {
    it("should answer 404 for a booking of another user", async () => {
      // ARRANGE
      db.queue([{ ...confirmedBooking, userId: "someone-else" }]);

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should replay the current state of an already cancelled booking without calling Mercado Pago", async () => {
      // ARRANGE
      db.queue([{ ...confirmedBooking, status: "cancelled" }], [refundRow({ status: "approved" })]);

      // ACT
      const result = await service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      expect(result).toEqual({
        bookingId: "booking-1",
        status: "cancelled",
        refund: { id: "refund-1", status: "completed", amountCents: 5000 },
      });
      expect(refundClient.total).not.toHaveBeenCalled();
    });

    it.each(["pending", "expired"])("should refuse a %s booking as not cancellable", async (status) => {
      // ARRANGE
      db.queue([{ ...confirmedBooking, status }]);

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(BookingNotCancellableException);
    });

    it("should refuse once the session starts in 2 hours or less, by the DB clock", async () => {
      // ARRANGE
      db.queue([{ ...confirmedBooking, startsAt: new Date(dbNow.getTime() + 2 * HOUR_MS) }]);

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(CancellationDeadlinePassedException);
      expect(refundClient.total).not.toHaveBeenCalled();
    });

    it("should cancel a booking without an approved payment right away, with no refund", async () => {
      // ARRANGE
      db.queue([confirmedBooking], []);

      // ACT
      const result = await service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      expect(result).toEqual({ bookingId: "booking-1", status: "cancelled", refund: null });
      expect(bookingService.cancelConfirmedBooking).toHaveBeenCalledWith(db, "booking-1");
      expect(insertedEventTypes()).toEqual(["booking_cancelled"]);
      expect(cancellationNotify).toHaveBeenCalledTimes(1);
      expect(refundClient.total).not.toHaveBeenCalled();
    });

    it("should refuse while another request for the same payment is still in flight", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [{ refund: refundRow(), stale: false }]);

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundInProgressException);
      expect(refundClient.total).not.toHaveBeenCalled();
    });

    it("should refuse while a refund is in process at Mercado Pago", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [{ refund: refundRow({ status: "in_process" }), stale: true }]);

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundInProgressException);
    });

    it("should map a concurrent insert hitting the active-refund index to refund in progress", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [], postgresError("23505"));

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundInProgressException);
    });

    it("should record the request, call a keyed total refund and cancel the booking when Mercado Pago approves it", async () => {
      // ARRANGE
      const requested = refundRow();
      const approved = refundRow({ status: "approved", externalRefundId: "777" });
      db.queue(
        // tx1: booking, approved payment, no active refund, inserted row, refund_requested
        [confirmedBooking],
        [approvedPayment],
        [],
        [requested],
        [],
        // tx2: booking lock, refund lock, update, refund_response, refund_confirmed, booking_cancelled, clear flag
        [{ id: "booking-1", status: "confirmed" }],
        [requested],
        [approved],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "approved" });

      // ACT
      const result = await service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      expect(refundClient.total).toHaveBeenCalledWith({
        payment_id: "4242",
        requestOptions: { idempotencyKey: "refund-1", timeout: 15_000 },
      });
      expect(result).toEqual({
        bookingId: "booking-1",
        status: "cancelled",
        refund: { id: "refund-1", status: "completed", amountCents: 5000 },
      });
      expect(insertedEventTypes()).toEqual([
        "refund_requested",
        "refund_response",
        "refund_confirmed",
        "booking_cancelled",
      ]);
      expect(cancellationNotify).toHaveBeenCalledTimes(1);
      expect(notificationService.sendRefundRequestedEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "cliente@test.com", seatLabels: ["A1", "A2"], amountCents: 5000 }),
      );
    });

    it("should reuse a stalled requested row and its idempotency key instead of inserting another", async () => {
      // ARRANGE
      const stalled = refundRow();
      db.queue(
        [confirmedBooking],
        [approvedPayment],
        [{ refund: stalled, stale: true }],
        [{ id: "booking-1", status: "confirmed" }],
        [stalled],
        [refundRow({ status: "in_process", externalRefundId: "777" })],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "in_process" });

      // ACT
      const result = await service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      expect(refundClient.total).toHaveBeenCalledWith(
        expect.objectContaining({ requestOptions: expect.objectContaining({ idempotencyKey: "refund-1" }) }),
      );
      expect(result.refund).toEqual({ id: "refund-1", status: "pending", amountCents: 5000 });
      expect(insertedEventTypes()).toEqual(["refund_response", "booking_cancelled"]);
    });

    it("should still answer when the refund email fails", async () => {
      // ARRANGE
      const requested = refundRow();
      db.queue(
        [confirmedBooking],
        [approvedPayment],
        [],
        [requested],
        [],
        [{ id: "booking-1", status: "confirmed" }],
        [requested],
        [refundRow({ status: "in_process", externalRefundId: "777" })],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "in_process" });
      notificationService.sendRefundRequestedEmail.mockRejectedValue(new Error("SMTP down"));

      // ACT
      const result = await service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      expect(result.status).toBe("cancelled");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to send refund requested email"));
    });

    it("should mark the row failed and answer REFUND_REQUEST_INVALID when Mercado Pago refuses with a 4xx", async () => {
      // ARRANGE
      const requested = refundRow();
      db.queue([confirmedBooking], [approvedPayment], [], [requested], [], [refundRow({ status: "failed" })]);
      refundClient.total.mockRejectedValue({ status: 400, cause: [{ code: 2063 }] });

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundRequestInvalidException);
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toMatchObject({
        status: "failed",
        errorCode: "2063",
      });
      expect(insertedEventTypes()).toEqual(["refund_requested", "refund_request_failed"]);
      expect(bookingService.cancelConfirmedBooking).not.toHaveBeenCalled();
    });

    it("should not log a failure event when the row already left requested", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [], [refundRow()], [], []);
      refundClient.total.mockRejectedValue({ status: 400 });

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundRequestInvalidException);
      expect(insertedEventTypes()).toEqual(["refund_requested"]);
    });

    it("should answer REFUND_IN_PROGRESS when Mercado Pago is still processing the same key", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [], [refundRow()], []);
      refundClient.total.mockRejectedValue({ status: 409 });

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundInProgressException);
    });

    it("should answer REFUND_PROVIDER_TIMEOUT and leave the row requested when Mercado Pago doesn't answer", async () => {
      // ARRANGE
      db.queue([confirmedBooking], [approvedPayment], [], [refundRow()], []);
      refundClient.total.mockRejectedValue(new Error("The operation was aborted due to timeout"));

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundProviderTimeoutException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should keep the booking confirmed and answer REFUND_REJECTED when the refund is rejected", async () => {
      // ARRANGE
      const requested = refundRow();
      db.queue(
        [confirmedBooking],
        [approvedPayment],
        [],
        [requested],
        [],
        [{ id: "booking-1", status: "confirmed" }],
        [requested],
        [refundRow({ status: "rejected", externalRefundId: "777" })],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "rejected" });

      // ACT
      const result = service.cancelWithRefund("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundRejectedException);
      expect(bookingService.cancelConfirmedBooking).not.toHaveBeenCalled();
      expect(insertedEventTypes()).toEqual(["refund_requested", "refund_response"]);
    });
  });

  describe("applyRefundStatus", () => {
    it("should ignore a redelivered status without writing anything", async () => {
      // ARRANGE
      const approved = refundRow({ status: "approved", externalRefundId: "777" });
      db.queue([{ id: "booking-1", status: "cancelled" }], [approved]);

      // ACT
      const result = await service.applyRefundStatus(db as never, approved, { id: 777, status: "approved" }, "webhook");
      await result.notify();

      // ASSERT
      expect(result.refund).toBe(approved);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(cancellationNotify).not.toHaveBeenCalled();
    });

    it("should only fill a missing external refund id when the status didn't change", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process" });
      db.queue([{ id: "booking-1", status: "cancelled" }], [inProcess]);

      // ACT
      await service.applyRefundStatus(db as never, inProcess, { id: 777, status: "in_process" }, "webhook");

      // ASSERT
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toMatchObject({ externalRefundId: "777" });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("should conclude an in-process refund from the webhook without a response event or email", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process", externalRefundId: "777" });
      db.queue(
        [{ id: "booking-1", status: "cancelled" }],
        [inProcess],
        [refundRow({ status: "approved", externalRefundId: "777" })],
      );
      bookingService.cancelConfirmedBooking.mockResolvedValue({
        cancelled: false,
        seatLabels: [],
        releasedSeatIds: [],
        notify: jest.fn(),
      });

      // ACT
      const result = await service.applyRefundStatus(db as never, inProcess, { id: 777, status: "approved" }, "webhook");
      await result.notify();

      // ASSERT
      expect(insertedEventTypes()).toEqual(["refund_confirmed"]);
      expect(db.calls.filter((call) => call.method === "set").map((call) => call.args[0])).toContainEqual({
        needsRefundReview: false,
      });
      expect(notificationService.sendRefundRequestedEmail).not.toHaveBeenCalled();
    });

    it("should flag the cancelled booking for review when an accepted refund is rejected later", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process", externalRefundId: "777" });
      db.queue(
        [{ id: "booking-1", status: "cancelled" }],
        [inProcess],
        [refundRow({ status: "rejected", externalRefundId: "777" })],
      );

      // ACT
      const result = await service.applyRefundStatus(db as never, inProcess, { id: 777, status: "rejected" }, "webhook");

      // ASSERT
      expect(result.refund.status).toBe("rejected");
      expect(db.calls.filter((call) => call.method === "set").map((call) => call.args[0])).toContainEqual({
        needsRefundReview: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Refund rejected after the booking was cancelled"));
    });
  });

  describe("applyRefundedPayment", () => {
    const context = { bookingId: "booking-1", paymentId: "payment-1", paymentStatus: "refunded", amountCents: 5000 };

    it("should do nothing but warn without a payment row", async () => {
      // ARRANGE / ACT
      const notify = await service.applyRefundedPayment(db as never, { ...context, paymentId: null, refunds: [] });
      await notify();

      // ASSERT
      expect(db.select).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("without a payment row"));
    });

    it("should apply each provider refund to the row matched by its external id", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process", externalRefundId: "777" });
      db.queue([inProcess]);
      const applySpy = jest
        .spyOn(service, "applyRefundStatus")
        .mockResolvedValue({ refund: inProcess, bookingStatus: "cancelled", notify: jest.fn() });

      // ACT
      await service.applyRefundedPayment(db as never, { ...context, refunds: [{ id: 777, status: "approved" }] });

      // ASSERT
      expect(applySpy).toHaveBeenCalledWith(db, inProcess, { id: 777, status: "approved" }, "webhook");
    });

    it("should fall back to the payment's active row still missing its external id", async () => {
      // ARRANGE
      const requested = refundRow();
      db.queue([], [requested]);
      const applySpy = jest
        .spyOn(service, "applyRefundStatus")
        .mockResolvedValue({ refund: requested, bookingStatus: "cancelled", notify: jest.fn() });

      // ACT
      await service.applyRefundedPayment(db as never, { ...context, refunds: [{ id: 777, status: "approved" }] });

      // ASSERT
      expect(applySpy).toHaveBeenCalledWith(db, requested, { id: 777, status: "approved" }, "webhook");
    });

    it("should record an approved refund made outside the API as external and cancel the booking", async () => {
      // ARRANGE
      const external = refundRow({ status: "approved", reason: "external", requestedBy: null, externalRefundId: "999" });
      db.queue([], [], [external]);

      // ACT
      const notify = await service.applyRefundedPayment(db as never, {
        ...context,
        refunds: [{ id: 999, status: "approved", amount: 30 }],
      });
      await notify();

      // ASSERT
      expect(db.calls.find((call) => call.method === "values")?.args[0]).toMatchObject({
        status: "approved",
        reason: "external",
        externalRefundId: "999",
        amountCents: 3000,
      });
      expect(insertedEventTypes()).toEqual(["refund_confirmed", "booking_cancelled"]);
      expect(bookingService.cancelConfirmedBooking).toHaveBeenCalledWith(db, "booking-1");
      expect(cancellationNotify).toHaveBeenCalledTimes(1);
      expect(notificationService.sendRefundRequestedEmail).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("recorded as external"));
    });

    it("should ignore an external refund that conflicts with an existing refund", async () => {
      // ARRANGE
      db.queue([], [], []);

      // ACT
      await service.applyRefundedPayment(db as never, { ...context, refunds: [{ id: 999, status: "approved" }] });

      // ASSERT
      expect(bookingService.cancelConfirmedBooking).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with an existing refund"));
    });

    it("should only warn about an unmatched refund that isn't an approved one", async () => {
      // ARRANGE
      db.queue([], []);

      // ACT
      await service.applyRefundedPayment(db as never, {
        ...context,
        paymentStatus: "approved",
        refunds: [{ id: 999, status: "rejected" }],
      });

      // ASSERT
      expect(db.insert).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unmatched refund"));
    });

    it("should record an external refund for a refunded payment listing no refunds and no approved row", async () => {
      // ARRANGE
      db.queue([], [refundRow({ status: "approved", reason: "external", requestedBy: null })]);

      // ACT
      await service.applyRefundedPayment(db as never, { ...context, refunds: [] });

      // ASSERT
      expect(db.calls.find((call) => call.method === "values")?.args[0]).toMatchObject({
        reason: "external",
        externalRefundId: null,
        amountCents: 5000,
      });
    });

    it("should not record anything for a refunded payment listing no refunds when an approved row exists", async () => {
      // ARRANGE
      db.queue([{ id: "refund-1" }]);

      // ACT
      await service.applyRefundedPayment(db as never, { ...context, refunds: [] });

      // ASSERT
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("requestAdminRefund", () => {
    const flaggedBooking = { id: "booking-1", needsRefundReview: true };

    it("should answer 404 for an unknown booking", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should refuse a booking that isn't in the review queue", async () => {
      // ARRANGE
      db.queue([{ id: "booking-1", needsRefundReview: false }], [{ refund: refundRow({ status: "in_process" }), stale: true }]);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundNotAllowedException);
    });

    it("should refuse while the last request is still in flight", async () => {
      // ARRANGE
      db.queue([flaggedBooking], [{ refund: refundRow(), stale: false }]);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundInProgressException);
    });

    it("should refuse a flagged booking without an approved payment", async () => {
      // ARRANGE
      db.queue([flaggedBooking], [], []);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundNotAllowedException);
    });

    it("should refund an expired paid booking with the admin as requester and the admin source", async () => {
      // ARRANGE
      const requested = refundRow({ reason: "expired_booking_review", requestedBy: "admin-1" });
      db.queue(
        [flaggedBooking],
        [],
        [approvedPayment],
        [],
        [requested],
        [],
        [{ id: "booking-1", status: "expired" }],
        [requested],
        [refundRow({ status: "approved", reason: "expired_booking_review", externalRefundId: "777" })],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "approved" });

      // ACT
      const result = await service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      expect(result).toEqual({
        bookingId: "booking-1",
        bookingStatus: "expired",
        refund: { id: "refund-1", status: "approved", amountCents: 5000 },
      });
      const inserted = db.calls.filter((call) => call.method === "values").map((call) => call.args[0]);
      expect(inserted[0]).toMatchObject({ reason: "expired_booking_review", requestedBy: "admin-1" });
      expect(inserted.slice(1).map((event) => (event as { payload: { source: string } }).payload.source)).toEqual([
        "admin",
        "admin",
        "admin",
      ]);
      expect(bookingService.cancelConfirmedBooking).not.toHaveBeenCalled();
    });

    it("should retry a stalled requested refund with its own key", async () => {
      // ARRANGE
      const stalled = refundRow();
      db.queue(
        [{ id: "booking-1", needsRefundReview: false }],
        [{ refund: stalled, stale: true }],
        [{ externalPaymentId: "4242" }],
        [{ id: "booking-1", status: "confirmed" }],
        [stalled],
        [refundRow({ status: "approved", externalRefundId: "777" })],
      );
      refundClient.total.mockResolvedValue({ id: 777, status: "approved" });

      // ACT
      const result = await service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      expect(refundClient.total).toHaveBeenCalledWith(
        expect.objectContaining({ payment_id: "4242", requestOptions: expect.objectContaining({ idempotencyKey: "refund-1" }) }),
      );
      expect(result.bookingStatus).toBe("cancelled");
    });

    it("should refuse a stalled refund whose payment has no Mercado Pago id", async () => {
      // ARRANGE
      db.queue([flaggedBooking], [{ refund: refundRow(), stale: true }], [{ externalPaymentId: null }]);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(RefundNotAllowedException);
    });

    it("should reconcile an in-process refund from the re-fetched payment instead of creating another", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process", reason: "expired_booking_review", externalRefundId: "777" });
      db.queue(
        [flaggedBooking],
        [{ refund: inProcess, stale: true }],
        [{ externalPaymentId: "4242" }],
        [{ id: "booking-1", status: "expired" }],
        [inProcess],
        [refundRow({ status: "approved", reason: "expired_booking_review", externalRefundId: "777" })],
      );
      paymentClient.get.mockResolvedValue({ id: 4242, refunds: [{ id: 1, status: "rejected" }, { id: 777, status: "approved" }] });

      // ACT
      const result = await service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      expect(paymentClient.get).toHaveBeenCalledWith({ id: 4242 });
      expect(refundClient.total).not.toHaveBeenCalled();
      expect(result.refund).toEqual({ id: "refund-1", status: "approved", amountCents: 5000 });
      expect(insertedEventTypes()).toEqual(["refund_response", "refund_confirmed"]);
    });

    it("should answer the current state when the re-fetched payment doesn't list the refund", async () => {
      // ARRANGE
      const inProcess = refundRow({ status: "in_process", externalRefundId: "777" });
      db.queue(
        [flaggedBooking],
        [{ refund: inProcess, stale: true }],
        [{ externalPaymentId: "4242" }],
        [inProcess],
        [{ status: "cancelled" }],
      );
      paymentClient.get.mockResolvedValue({ id: 4242, refunds: [] });

      // ACT
      const result = await service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      expect(result).toEqual({
        bookingId: "booking-1",
        bookingStatus: "cancelled",
        refund: { id: "refund-1", status: "in_process", amountCents: 5000 },
      });
    });

    it.each([
      ["a timeout", new Error("timeout"), RefundProviderTimeoutException],
      ["a 4xx", { status: 404 }, RefundRequestInvalidException],
    ])("should map %s while re-fetching the payment", async (_case, err, expected) => {
      // ARRANGE
      db.queue(
        [flaggedBooking],
        [{ refund: refundRow({ status: "in_process", externalRefundId: "777" }), stale: true }],
        [{ externalPaymentId: "4242" }],
      );
      paymentClient.get.mockRejectedValue(err);

      // ACT
      const result = service.requestAdminRefund("booking-1", "admin-1");

      // ASSERT
      await expect(result).rejects.toThrow(expected);
    });
  });
});
