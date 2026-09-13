import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { MyBooking } from "./my-booking.types";

export interface CreateBookingResult {
  bookingId: string;
  seatId: string;
  status: string;
}

export interface ConfirmBookingResult {
  bookingId: string;
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

  /**
   * Mocked payment confirmation: flips a pending booking to confirmed so it
   * shows as "booked" on the seat map. Real payment gateway integration and
   * seat-conflict handling land in a later story.
   */
  async confirmBooking(bookingId: string, userId: string): Promise<ConfirmBookingResult> {
    const booking = await this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
    });
    if (!booking || booking.userId !== userId) {
      throw new NotFoundException("Reserva não encontrada");
    }
    if (booking.status !== "pending") {
      throw new ConflictException(`Reserva já está com status "${booking.status}"`);
    }

    const [updated] = await this.db
      .update(schema.bookings)
      .set({ status: "confirmed" })
      .where(eq(schema.bookings.id, bookingId))
      .returning();

    return { bookingId: updated.id, status: updated.status };
  }

  /** Lists the authenticated user's confirmed bookings, most recent first. */
  async getMyBookings(userId: string): Promise<MyBooking[]> {
    const bookings = await this.db.query.bookings.findMany({
      where: eq(schema.bookings.userId, userId),
      orderBy: desc(schema.bookings.createdAt),
      with: {
        session: { with: { movie: true, room: { with: { cinema: true } } } },
        seats: { with: { seat: true } },
      },
    });

    return bookings
      .filter((booking) => booking.status === "confirmed")
      .map((booking) => ({
        bookingId: booking.id,
        status: booking.status,
        session: {
          id: booking.session.id,
          startsAt: booking.session.startsAt.toISOString(),
          priceCents: booking.session.priceCents,
          movie: { title: booking.session.movie.title },
          room: { name: booking.session.room.name },
          cinema: { name: booking.session.room.cinema.name, city: booking.session.room.cinema.city },
        },
        seats: booking.seats.map((bookingSeat) => ({
          rowLabel: bookingSeat.seat.rowLabel,
          seatNumber: bookingSeat.seat.seatNumber,
        })),
      }));
  }
}
