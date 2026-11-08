import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import * as schema from "../../db/schema";
import { scanSessionHoldKeys } from "../../seating/hold-keys";
import { VALKEY } from "../../valkey/valkey.module";
import { Tx } from "../shared/db.types";
import { SessionActivity } from "./session-edit-policy";

/** Reads a session's bookings (Postgres) and active seat holds (Valkey `seat-hold:<sessionId>:*`). */
@Injectable()
export class SessionActivityService {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async read(tx: Tx, sessionId: string): Promise<SessionActivity> {
    const bookings = await tx
      .selectDistinct({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.sessionId, sessionId));
    const statuses = new Set(bookings.map((booking) => booking.status));
    const holdKeys = await scanSessionHoldKeys(this.valkey, sessionId);

    return {
      hasPendingBooking: statuses.has("pending"),
      hasConfirmedBooking: statuses.has("confirmed"),
      hasAnyBooking: statuses.size > 0,
      hasActiveHold: holdKeys.length > 0,
    };
  }
}
