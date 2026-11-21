import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  activeBookingCondition,
  CANCELLATION_DEADLINE_MINUTES,
  cancellableUntil,
  expirableBookingCondition,
  groupSeatsByBooking,
  isPastCancellationDeadline,
  notPastDeadline,
  pastDeadline,
  PENDING_BOOKING_TTL_MINUTES,
  pendingBookingExpiresAt,
  STALE_PAYMENT_ALERT_HOURS,
  stalePaymentAlertCondition,
} from "./booking-lock";

const dialect = new PgDialect();

function render(condition: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(condition);
}

const IN_FLIGHT = `exists (select 1 from "payments" where "payments"."booking_id" = "bookings"."id" and "payments"."status" in ($`;

describe("booking-lock", () => {
  it("should keep the pending booking TTL at 10 minutes and the stale payment alert at 24 hours", () => {
    // ARRANGE
    const expected = { ttlMinutes: 10, staleHours: 24 };

    // ACT
    const actual = { ttlMinutes: PENDING_BOOKING_TTL_MINUTES, staleHours: STALE_PAYMENT_ALERT_HOURS };

    // ASSERT
    expect(actual).toEqual(expected);
  });

  it("should compute expires_at with the DB clock and the TTL constant", () => {
    // ARRANGE
    const expression = pendingBookingExpiresAt();

    // ACT
    const query = render(expression);

    // ASSERT
    expect(query.sql).toBe("now() + make_interval(mins => $1)");
    expect(query.params).toEqual([PENDING_BOOKING_TTL_MINUTES]);
  });

  it.each([
    {
      name: "activeBookingCondition",
      build: activeBookingCondition,
      fragments: [`"bookings"."status" = $1`, `"bookings"."expires_at" > now()`, `or ${IN_FLIGHT}`],
      params: ["confirmed", "pending", "pending", "in_process"],
    },
    {
      name: "expirableBookingCondition",
      build: expirableBookingCondition,
      fragments: [`"bookings"."status" = $1`, `"bookings"."expires_at" <= now()`, `not ${IN_FLIGHT}`],
      params: ["pending", "pending", "in_process"],
    },
    {
      name: "stalePaymentAlertCondition",
      build: stalePaymentAlertCondition,
      fragments: [
        `"bookings"."stale_payment_alerted_at" is null`,
        `"bookings"."created_at" <= now() - make_interval(hours => $2)`,
        `and ${IN_FLIGHT}`,
      ],
      params: ["pending", STALE_PAYMENT_ALERT_HOURS, "pending", "in_process"],
    },
    {
      name: "pastDeadline",
      build: () => pastDeadline(),
      fragments: [`"bookings"."expires_at" <= now()`],
      params: [],
    },
    {
      name: "notPastDeadline",
      build: notPastDeadline,
      fragments: [`"bookings"."expires_at" > now()`],
      params: [],
    },
  ])("should render $name against the DB clock with the expected filters", ({ build, fragments, params }) => {
    // ARRANGE
    const condition = build();

    // ACT
    const query = render(condition);

    // ASSERT
    for (const fragment of fragments) {
      expect(query.sql).toContain(fragment);
    }
    expect(query.params).toEqual(params);
  });

  it.each([
    { rows: [], expected: [] },
    {
      rows: [{ bookingId: "b1", seatId: "s1" }],
      expected: [["b1", ["s1"]]],
    },
    {
      rows: [
        { bookingId: "b1", seatId: "s1" },
        { bookingId: "b2", seatId: "s3" },
        { bookingId: "b1", seatId: "s2" },
      ],
      expected: [
        ["b1", ["s1", "s2"]],
        ["b2", ["s3"]],
      ],
    },
  ])("should group $rows.length freed seat rows by booking", ({ rows, expected }) => {
    // ARRANGE
    const input = rows;

    // ACT
    const grouped = groupSeatsByBooking(input);

    // ASSERT
    expect([...grouped.entries()]).toEqual(expected);
  });

  // Refund spec (docs/flows/refund/spec.md) AC5 / D1
  describe("cancellation deadline", () => {
    const now = new Date("2026-11-20T16:00:00.000Z");
    const MINUTE_MS = 60 * 1000;

    it.each([
      ["3 hours away", 180, false],
      ["2 hours and 1 minute away", 121, false],
      ["exactly 2 hours away", 120, true],
      ["1 hour away", 60, true],
      ["already started", -10, true],
    ])("should tell whether a session starting %s is past the cancellation deadline", (_case, minutesAway, expected) => {
      // ARRANGE
      const startsAt = new Date(now.getTime() + minutesAway * MINUTE_MS);

      // ACT
      const past = isPastCancellationDeadline(startsAt, now);

      // ASSERT
      expect(past).toBe(expected);
    });

    it("should place the cancellation deadline 2 hours before the session starts", () => {
      // ARRANGE
      const startsAt = new Date("2026-11-20T20:00:00.000Z");

      // ACT
      const deadline = cancellableUntil(startsAt);

      // ASSERT
      expect(deadline.toISOString()).toBe("2026-11-20T18:00:00.000Z");
      expect(CANCELLATION_DEADLINE_MINUTES).toBe(120);
    });
  });
});
