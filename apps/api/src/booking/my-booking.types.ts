import { CustomerRefundStatus } from "../refund/refund-status";

export interface MyBookingSeat {
  rowLabel: string;
  seatNumber: number;
}

export interface MyBookingRefund {
  status: CustomerRefundStatus;
  amountCents: number;
  requestedAt: string;
}

export interface MyBooking {
  bookingId: string;
  status: string;
  session: {
    id: string;
    startsAt: string;
    priceCents: number;
    movie: { title: string };
    room: { name: string };
    cinema: { name: string; city: string };
  };
  seats: MyBookingSeat[];
  /** Sum of the seats' prices, or the last refund's amount once the seats were released. */
  amountCents: number;
  /** `session.startsAt` minus the cancellation deadline. */
  cancellableUntil: string;
  /** Last refund of the booking, or null. */
  refund: MyBookingRefund | null;
}
