/** What a session currently has going on in the purchase flow. */
export interface SessionActivity {
  /** A pending booking that still locks its seats (within its deadline or with a payment in flight). */
  hasPendingBooking: boolean;
  hasConfirmedBooking: boolean;
  /** Any booking at all, `cancelled`/`expired` included (they keep payment history). */
  hasAnyBooking: boolean;
  hasActiveHold: boolean;
}

export interface SessionChanges {
  /** `movieId`, `roomId` or `startsAt` differs from what is stored. */
  schedule: boolean;
  /** `priceCents` differs from what is stored. */
  price: boolean;
}

export function hasStarted(startsAt: Date, now: Date = new Date()): boolean {
  return startsAt.getTime() <= now.getTime();
}

/**
 * Why an edit must be refused (409), or undefined when it's allowed.
 * Movie/room/time can't move under anyone who booked or is holding a seat.
 * The price can still change with only confirmed bookings, because each sold
 * seat keeps the price it was paid at (`booking_seats.price_cents`), but not
 * while someone is mid-checkout (pending booking or active hold).
 */
export function sessionEditBlockReason(changes: SessionChanges, activity: SessionActivity): string | undefined {
  if (changes.schedule && (activity.hasPendingBooking || activity.hasConfirmedBooking || activity.hasActiveHold)) {
    return "Sessão tem reservas ou assentos segurados: filme, sala e horário não podem mudar";
  }
  if (changes.price && (activity.hasPendingBooking || activity.hasActiveHold)) {
    return "Sessão tem compras em andamento: o preço não pode mudar agora";
  }
  return undefined;
}

/** Why a delete must be refused (409), or undefined when it's allowed. */
export function sessionDeleteBlockReason(activity: SessionActivity): string | undefined {
  if (activity.hasAnyBooking) {
    return "Sessão tem reservas e não pode ser excluída";
  }
  if (activity.hasActiveHold) {
    return "Sessão tem assentos segurados e não pode ser excluída";
  }
  return undefined;
}
