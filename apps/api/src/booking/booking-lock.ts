import { and, AnyColumn, eq, gt, lte, or, sql, SQL } from "drizzle-orm";
import * as schema from "../db/schema";

/** How long a pending booking keeps its seats locked without a payment in flight. */
export const PENDING_BOOKING_TTL_MINUTES = 10;

/** Age (from `bookings.created_at`) after which a pending booking with an in-flight payment is alerted once. */
export const STALE_PAYMENT_ALERT_HOURS = 24;

/** `payments.status` values that mean Mercado Pago may still settle the payment. */
export const IN_FLIGHT_PAYMENT_STATUSES = ["pending", "in_process"] as const;

const { bookings, payments } = schema;

/** `expires_at` for a new pending booking, always computed by the DB clock (never the API instance's). */
export function pendingBookingExpiresAt(): SQL<Date> {
  return sql<Date>`now() + make_interval(mins => ${PENDING_BOOKING_TTL_MINUTES})`;
}

/**
 * True when any `payments` row of the booking is still pending/in_process.
 * Written as EXISTS so it works with one row per booking (today) or one row
 * per payment attempt.
 */
export function hasInFlightPayment(): SQL {
  return sql`exists (select 1 from ${payments} where ${payments.bookingId} = ${bookings.id} and ${payments.status} in (${sql.join(
    IN_FLIGHT_PAYMENT_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}))`;
}

/**
 * True when the booking's pending deadline has passed, by the DB clock. Takes
 * the column so relational queries can pass their aliased table's column.
 */
export function pastDeadline(expiresAt: AnyColumn = bookings.expiresAt): SQL<boolean> {
  return sql<boolean>`${expiresAt} <= now()`;
}

/**
 * The single "this booking still locks its seats" rule, shared by the seat
 * map, the hold check, booking creation and the sweeper: confirmed, or
 * pending and either still within its deadline or with a payment in flight.
 */
export function activeBookingCondition(): SQL {
  return or(
    eq(bookings.status, "confirmed"),
    and(eq(bookings.status, "pending"), or(gt(bookings.expiresAt, sql`now()`), hasInFlightPayment())),
  )!;
}

/** A pending booking past its deadline with no payment in flight: safe to flip to `expired`. */
export function expirableBookingCondition(): SQL {
  return and(
    eq(bookings.status, "pending"),
    lte(bookings.expiresAt, sql`now()`),
    sql`not ${hasInFlightPayment()}`,
  )!;
}

/** A pending booking with a payment in flight for longer than {@link STALE_PAYMENT_ALERT_HOURS}, not alerted yet. */
export function stalePaymentAlertCondition(): SQL {
  return and(
    eq(bookings.status, "pending"),
    sql`${bookings.stalePaymentAlertedAt} is null`,
    lte(bookings.createdAt, sql`now() - make_interval(hours => ${STALE_PAYMENT_ALERT_HOURS})`),
    hasInFlightPayment(),
  )!;
}

/** Negation of {@link pastDeadline}: the pending deadline hasn't passed yet, by the DB clock. */
export function notPastDeadline(): SQL {
  return gt(bookings.expiresAt, sql`now()`);
}

/** Groups freed `booking_seats` rows by booking, preserving the order bookings first appear in. */
export function groupSeatsByBooking(rows: { bookingId: string; seatId: string }[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const { bookingId, seatId } of rows) {
    const seatIds = grouped.get(bookingId) ?? [];
    seatIds.push(seatId);
    grouped.set(bookingId, seatIds);
  }
  return grouped;
}
