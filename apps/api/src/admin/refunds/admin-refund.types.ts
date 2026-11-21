export type RefundReviewReason = "expired_booking_paid" | "refund_rejected" | "refund_stalled";

export interface RefundReviewItem {
  bookingId: string;
  bookingStatus: string;
  customerEmail: string;
  movieTitle: string;
  sessionStartsAt: string;
  amountCents: number;
  externalPaymentId: string | null;
  /** `payments.updated_at` of the payment being refunded. */
  paymentApprovedAt: string | null;
  reviewReason: RefundReviewReason;
  /** Last refund of the booking, or null. */
  refund: { id: string; status: string; errorCode: string | null; updatedAt: string } | null;
}
