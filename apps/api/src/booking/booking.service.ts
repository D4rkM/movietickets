import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { TicketType } from "./dto/book-seat.dto";

const HALF_PRICE_RATIO = 0.5;

export interface CreateBookingResult {
  bookingId: string;
  seatId: string;
  status: string;
  ticketType: TicketType;
  priceCents: number;
}

@Injectable()
export class BookingService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  /**
   * MVP insert: no hold/TTL, no conflict check, no unique constraint yet.
   * Two clients can insert the same seat here — that gets closed in the
   * "Segurar assento" and "Confirmar assento definitivo" stories.
   */
  async createBooking(
    sessionId: string,
    seatId: string,
    userId: string,
    ticketType: TicketType,
    halfPriceDocument: string | undefined,
  ): Promise<CreateBookingResult> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    const priceCents =
      ticketType === TicketType.HALF
        ? Math.round(session.priceCents * HALF_PRICE_RATIO)
        : session.priceCents;

    const [booking] = await this.db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "pending" })
      .returning();

    await this.db.insert(schema.bookingSeats).values({
      bookingId: booking.id,
      sessionId,
      seatId,
      ticketType,
      halfPriceDocument: ticketType === TicketType.HALF ? halfPriceDocument : null,
      priceCents,
    });

    return { bookingId: booking.id, seatId, status: booking.status, ticketType, priceCents };
  }
}
