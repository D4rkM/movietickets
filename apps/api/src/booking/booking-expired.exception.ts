import { ConflictException } from "@nestjs/common";

export const BOOKING_EXPIRED_CODE = "BOOKING_EXPIRED";

/** 409 with a stable `code`, so the front can tell an expired booking apart from other conflicts. */
export class BookingExpiredException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: BOOKING_EXPIRED_CODE,
      message: "Reserva expirada. Escolha os assentos novamente.",
    });
  }
}

/**
 * Throws {@link BookingExpiredException} when the booking is `expired`, or
 * still `pending` but past its deadline (`pastDeadline` must come from the
 * DB clock). Applies even with a payment in flight: no new attempt or mock
 * confirmation after the deadline, the in-flight payment settles via webhook.
 */
export function assertBookingNotExpired(booking: { status: string; pastDeadline: boolean }): void {
  if (booking.status === "expired" || (booking.status === "pending" && booking.pastDeadline)) {
    throw new BookingExpiredException();
  }
}
