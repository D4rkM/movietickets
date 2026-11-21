import { FastifyRequest } from "fastify";
import { createFakeDb } from "../../../test/helpers/fake-db";
import { RefundService } from "../../refund/refund.service";
import { AdminRefundsController } from "./admin-refunds.controller";
import { buildRefundReviewItem, refundReviewReason } from "./refund-review";
import { RefundReviewQueriesService } from "./refund-review-queries.service";

const startsAt = new Date("2026-11-20T20:00:00.000Z");
const approvedAt = new Date("2026-11-20T10:00:00.000Z");

function reviewBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    status: "expired",
    user: { email: "cliente@test.com" },
    session: { startsAt, movie: { title: "Dune" } },
    payments: [
      { id: "payment-old", status: "rejected", externalPaymentId: "1", amountCents: 5000, updatedAt: new Date(0) },
      { id: "payment-1", status: "approved", externalPaymentId: "4242", amountCents: 5000, updatedAt: approvedAt },
    ],
    refunds: [] as {
      id: string;
      paymentId: string;
      status: string;
      amountCents: number;
      errorCode: string | null;
      updatedAt: Date;
    }[],
    ...overrides,
  };
}

describe("Admin refund review", () => {
  describe("refundReviewReason", () => {
    it.each([
      [undefined, false, "expired_booking_paid"],
      ["failed", false, "expired_booking_paid"],
      ["in_process", false, "expired_booking_paid"],
      ["rejected", false, "refund_rejected"],
      ["requested", true, "refund_stalled"],
    ])("should explain a last refund %s (stalled: %s) as %s", (status, stalled, expected) => {
      // ARRANGE / ACT
      const reason = refundReviewReason(status, stalled);

      // ASSERT
      expect(reason).toBe(expected);
    });
  });

  describe("buildRefundReviewItem", () => {
    it("should describe an expired booking with an approved payment and no refund yet", () => {
      // ARRANGE
      const booking = reviewBooking();

      // ACT
      const item = buildRefundReviewItem(booking, new Set());

      // ASSERT
      expect(item).toEqual({
        bookingId: "booking-1",
        bookingStatus: "expired",
        customerEmail: "cliente@test.com",
        movieTitle: "Dune",
        sessionStartsAt: "2026-11-20T20:00:00.000Z",
        amountCents: 5000,
        externalPaymentId: "4242",
        paymentApprovedAt: "2026-11-20T10:00:00.000Z",
        reviewReason: "expired_booking_paid",
        refund: null,
      });
    });

    it("should describe a stalled requested refund from its own payment", () => {
      // ARRANGE
      const booking = reviewBooking({
        status: "confirmed",
        refunds: [
          {
            id: "refund-1",
            paymentId: "payment-1",
            status: "requested",
            amountCents: 5000,
            errorCode: null,
            updatedAt: approvedAt,
          },
        ],
      });

      // ACT
      const item = buildRefundReviewItem(booking, new Set(["refund-1"]));

      // ASSERT
      expect(item.reviewReason).toBe("refund_stalled");
      expect(item.externalPaymentId).toBe("4242");
      expect(item.refund).toEqual({
        id: "refund-1",
        status: "requested",
        errorCode: null,
        updatedAt: "2026-11-20T10:00:00.000Z",
      });
    });

    it("should fall back to the refund amount when the payment is unknown", () => {
      // ARRANGE
      const booking = reviewBooking({
        payments: [],
        refunds: [
          { id: "refund-1", paymentId: "gone", status: "rejected", amountCents: 3000, errorCode: null, updatedAt: approvedAt },
        ],
      });

      // ACT
      const item = buildRefundReviewItem(booking, new Set());

      // ASSERT
      expect(item).toMatchObject({
        amountCents: 3000,
        externalPaymentId: null,
        paymentApprovedAt: null,
        reviewReason: "refund_rejected",
      });
    });
  });

  describe("RefundReviewQueriesService", () => {
    it("should list flagged bookings plus bookings with a stalled requested refund", async () => {
      // ARRANGE
      const db = createFakeDb();
      db.query.bookings = { findFirst: jest.fn(), findMany: jest.fn() };
      db.queue([{ id: "refund-1", bookingId: "booking-2" }]);
      db.query.bookings.findMany.mockResolvedValue([
        reviewBooking({
          id: "booking-2",
          status: "confirmed",
          refunds: [
            { id: "refund-1", paymentId: "payment-1", status: "requested", amountCents: 5000, errorCode: null, updatedAt: approvedAt },
          ],
        }),
      ]);
      const service = new RefundReviewQueriesService(db as never);

      // ACT
      const items = await service.listReviewQueue();

      // ASSERT
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ bookingId: "booking-2", reviewReason: "refund_stalled" });
      expect(db.query.bookings.findMany).toHaveBeenCalledTimes(1);
    });

    it("should only query flagged bookings when no refund is stalled", async () => {
      // ARRANGE
      const db = createFakeDb();
      db.query.bookings = { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([reviewBooking()]) };
      const service = new RefundReviewQueriesService(db as never);

      // ACT
      const items = await service.listReviewQueue();

      // ASSERT
      expect(items).toEqual([expect.objectContaining({ bookingId: "booking-1", reviewReason: "expired_booking_paid" })]);
    });
  });

  describe("AdminRefundsController", () => {
    it("should delegate the queue to the queries service and the refund to RefundService with the admin id", async () => {
      // ARRANGE
      const queries = { listReviewQueue: jest.fn().mockResolvedValue([]) };
      const refundService = { requestAdminRefund: jest.fn().mockResolvedValue({ bookingId: "booking-1" }) };
      const controller = new AdminRefundsController(
        queries as unknown as RefundReviewQueriesService,
        refundService as unknown as RefundService,
      );
      const request = { user: { sub: "admin-1", email: "admin@test.com", role: "admin" } } as FastifyRequest;

      // ACT
      const queue = await controller.listReviewQueue();
      const result = await controller.refundBooking("booking-1", request);

      // ASSERT
      expect(queue).toEqual([]);
      expect(refundService.requestAdminRefund).toHaveBeenCalledWith("booking-1", "admin-1");
      expect(result).toEqual({ bookingId: "booking-1" });
    });
  });
});
