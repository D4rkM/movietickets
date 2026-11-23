export interface TicketSeat {
  rowLabel: string;
  seatNumber: number;
}

/** Customer-facing refund status: requested/in_process → pending; approved → completed; failed/rejected → failed. */
export type TicketRefundStatus = "pending" | "completed" | "failed";

export interface TicketRefund {
  status: TicketRefundStatus;
  amountCents: number;
  /** Sent by `GET /bookings/mine`; absent when the refund comes from the cancel response. */
  requestedAt?: string;
}

export interface Ticket {
  bookingId: string;
  /** `confirmed`, or `cancelled`/`expired` when the booking has a refund. */
  status: string;
  session: {
    id: string;
    startsAt: string;
    priceCents: number;
    movie: { title: string };
    room: { name: string };
    cinema: { name: string; city: string };
  };
  seats: TicketSeat[];
  /** Total paid for the booking (sum of seat prices, or the refund amount once seats were released). */
  amountCents: number;
  /** Last moment the booking can still be cancelled (session start minus 2 hours). */
  cancellableUntil: string;
  /** Last refund of the booking, or null. */
  refund: TicketRefund | null;
}

/** Response of `POST /bookings/:id/cancel`. */
export interface CancelBookingResult {
  bookingId: string;
  status: string;
  /** Null when the booking had no approved payment (cancelled without refund). */
  refund: { id: string; status: TicketRefundStatus; amountCents: number } | null;
}
