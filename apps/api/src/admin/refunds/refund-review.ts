import { RefundReviewItem, RefundReviewReason } from "./admin-refund.types";

interface ReviewBooking {
  id: string;
  status: string;
  user: { email: string };
  session: { startsAt: Date; movie: { title: string } };
  payments: { id: string; status: string; externalPaymentId: string | null; amountCents: number; updatedAt: Date }[];
  /** Most recent first. */
  refunds: {
    id: string;
    paymentId: string;
    status: string;
    amountCents: number;
    errorCode: string | null;
    updatedAt: Date;
  }[];
}

/**
 * Why a booking is in the admin refund queue: its last refund is a stalled
 * `requested` one, it was `rejected` (after the booking was cancelled, or on a
 * previous admin attempt), or an approved payment landed on an expired booking.
 */
export function refundReviewReason(lastRefundStatus: string | undefined, stalled: boolean): RefundReviewReason {
  if (stalled) return "refund_stalled";
  if (lastRefundStatus === "rejected") return "refund_rejected";
  return "expired_booking_paid";
}

/** Pure mapper from a queued booking (with its payments and refunds) to a review-queue item. */
export function buildRefundReviewItem(booking: ReviewBooking, staleRefundIds: Set<string>): RefundReviewItem {
  const lastRefund = booking.refunds[0];
  const payment = lastRefund
    ? booking.payments.find((candidate) => candidate.id === lastRefund.paymentId)
    : [...booking.payments]
        .filter((candidate) => candidate.status === "approved")
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  const stalled = lastRefund?.status === "requested" && staleRefundIds.has(lastRefund.id);

  return {
    bookingId: booking.id,
    bookingStatus: booking.status,
    customerEmail: booking.user.email,
    movieTitle: booking.session.movie.title,
    sessionStartsAt: booking.session.startsAt.toISOString(),
    amountCents: payment?.amountCents ?? lastRefund?.amountCents ?? 0,
    externalPaymentId: payment?.externalPaymentId ?? null,
    paymentApprovedAt: payment ? payment.updatedAt.toISOString() : null,
    reviewReason: refundReviewReason(lastRefund?.status, stalled),
    refund: lastRefund
      ? {
          id: lastRefund.id,
          status: lastRefund.status,
          errorCode: lastRefund.errorCode,
          updatedAt: lastRefund.updatedAt.toISOString(),
        }
      : null,
  };
}
