export const MOVIE_RATINGS = ["L", "10", "12", "14", "16", "18"] as const;
export type MovieRating = (typeof MOVIE_RATINGS)[number];

export interface AdminMovie {
  id: string;
  title: string;
  synopsis: string | null;
  durationMinutes: number;
  posterUrl: string | null;
  rating: string | null;
}

export interface CreateMovieInput {
  title: string;
  synopsis?: string | null;
  durationMinutes: number;
  posterUrl?: string | null;
  rating?: string | null;
}

export type UpdateMovieInput = Partial<CreateMovieInput>;

export interface AdminCinema {
  id: string;
  name: string;
  address: string;
  city: string;
}

export interface CreateCinemaInput {
  name: string;
  address: string;
  city: string;
}

export type UpdateCinemaInput = Partial<CreateCinemaInput>;

export interface AdminRoom {
  id: string;
  name: string;
  rows: number;
  seatsPerRow: number;
  cinemaId: string;
  cinemaName: string;
}

export interface CreateRoomInput {
  cinemaId: string;
  name: string;
  rows: number;
  seatsPerRow: number;
}

export interface UpdateRoomInput {
  name?: string;
  rows?: number;
  seatsPerRow?: number;
}

export interface AdminSession {
  id: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  movie: { id: string; title: string; durationMinutes: number };
  room: { id: string; name: string };
  cinema: { id: string; name: string };
}

export interface CreateSessionInput {
  movieId: string;
  roomId: string;
  startsAt: string;
  priceCents: number;
}

export type UpdateSessionInput = Partial<CreateSessionInput>;

/** Why a booking is in the admin refund review queue. */
export type RefundReviewReason = "expired_booking_paid" | "refund_rejected" | "refund_stalled";

/** Raw refund status, as stored by the backend (not the customer-facing simplification). */
export type AdminRefundStatus = "requested" | "in_process" | "approved" | "rejected" | "failed";

/** Item of `GET /admin/refunds/review`. */
export interface RefundReviewItem {
  bookingId: string;
  bookingStatus: string;
  customerEmail: string;
  movieTitle: string;
  sessionStartsAt: string;
  amountCents: number;
  externalPaymentId: string | null;
  paymentApprovedAt: string | null;
  reviewReason: RefundReviewReason;
  /** Last refund of the booking, or null. */
  refund: { id: string; status: AdminRefundStatus; errorCode: string | null; updatedAt: string } | null;
}

/** Response of `POST /admin/bookings/:id/refund`. */
export interface AdminRefundResult {
  bookingId: string;
  bookingStatus: string;
  refund: { id: string; status: AdminRefundStatus; amountCents: number } | null;
}
