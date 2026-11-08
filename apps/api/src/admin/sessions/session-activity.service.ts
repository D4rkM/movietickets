import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { activeBookingCondition } from "../../booking/booking-lock";
import * as schema from "../../db/schema";
import { scanSessionHoldKeys } from "../../seating/hold-keys";
import { VALKEY } from "../../valkey/valkey.module";
import { Tx } from "../shared/db.types";
import { SessionActivity } from "./session-edit-policy";

/**
 * Reads a session's bookings (Postgres) and active seat holds (Valkey
 * `seat-hold:<sessionId>:*`).
 *
 * A pending booking only counts as pending while it still locks its seats,
 * by the same rule the booking flow uses (`activeBookingCondition`): within
 * its deadline or with a payment in flight. Past that it is history, like
 * `cancelled`/`expired`: it no longer blocks edits, but still blocks deletes.
 */
@Injectable()
export class SessionActivityService {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async read(tx: Tx, sessionId: string): Promise<SessionActivity> {
    const bookings = await tx
      .select({
        status: schema.bookings.status,
        locksSeats: sql<boolean>`(${activeBookingCondition()})`,
      })
      .from(schema.bookings)
      .where(eq(schema.bookings.sessionId, sessionId));
    const holdKeys = await scanSessionHoldKeys(this.valkey, sessionId);

    return {
      hasPendingBooking: bookings.some((booking) => booking.status === "pending" && booking.locksSeats),
      hasConfirmedBooking: bookings.some((booking) => booking.status === "confirmed"),
      hasAnyBooking: bookings.length > 0,
      hasActiveHold: holdKeys.length > 0,
    };
  }
}
