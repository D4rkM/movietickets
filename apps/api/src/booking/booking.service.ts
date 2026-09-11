import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";

export interface CreateBookingResult {
  bookingId: string;
  seatId: string;
  status: string;
}

@Injectable()
export class BookingService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  /**
   * MVP insert: no hold/TTL, no conflict check, no unique constraint yet.
   * Two clients can insert the same seat here — that gets closed in the
   * "Segurar assento" and "Confirmar assento definitivo" stories.
   */
  async createBooking(sessionId: string, seatId: string, userId: string): Promise<CreateBookingResult> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    const [booking] = await this.db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "pending" })
      .returning();

    await this.db.insert(schema.bookingSeats).values({ bookingId: booking.id, sessionId, seatId });

    return { bookingId: booking.id, seatId, status: booking.status };
  }
}
