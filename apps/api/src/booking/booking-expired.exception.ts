import { ConflictException } from "@nestjs/common";

export const BOOKING_EXPIRED_CODE = "BOOKING_EXPIRED";
export const BOOKING_NOT_PENDING_CODE = "BOOKING_NOT_PENDING";
export const BOOKING_ALREADY_PENDING_CODE = "BOOKING_ALREADY_PENDING";

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

/** 409 when a booking is in a non-pending terminal state (`confirmed` or `cancelled`). */
export class BookingNotPendingException extends ConflictException {
  constructor(status: string) {
    super({
      statusCode: 409,
      code: BOOKING_NOT_PENDING_CODE,
      message: `Reserva já está com status "${status}"`,
    });
  }
}

/**
 * 409 returned when the user tries to book the exact same set of seats they
 * already hold in an active `pending` booking for that session, allowing the
 * front-end to resume the existing booking instead of creating another.
 */
export class BookingAlreadyPendingException extends ConflictException {
  constructor(bookingId: string) {
    super({
      statusCode: 409,
      code: BOOKING_ALREADY_PENDING_CODE,
      bookingId,
      message: "Você já tem uma reserva pendente para esses assentos.",
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
