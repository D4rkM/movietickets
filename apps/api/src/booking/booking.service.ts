import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { TicketType } from "./dto/book-seat.dto";
import { MyBooking } from "./my-booking.types";

const HALF_PRICE_RATIO = 0.5;
const UNIQUE_VIOLATION = "23505";

export interface SeatChoice {
  seatId: string;
  ticketType: TicketType;
  halfPriceDocument?: string;
}

export interface CreateBookingResult {
  bookingId: string;
  seatId: string;
  status: string;
  ticketType: TicketType;
  priceCents: number;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// drizzle-orm wraps the driver's PostgresError in a DrizzleQueryError, so the
// Postgres error code (e.g. "23505" for a unique violation) lives on `.cause`
// rather than on the error itself.
function isUniqueViolation(err: unknown): boolean {
  if (hasCode(err, UNIQUE_VIOLATION)) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return hasCode(cause, UNIQUE_VIOLATION);
}

export interface ConfirmBookingResult {
  bookingId: string;
  status: string;
}

@Injectable()
export class BookingService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  /** Single-seat convenience wrapper around {@link createBookingForSeats}. */
  async createBooking(
    sessionId: string,
    seatId: string,
    userId: string,
    ticketType: TicketType,
    halfPriceDocument: string | undefined,
  ): Promise<CreateBookingResult> {
    const [result] = await this.createBookingForSeats(
      sessionId,
      [{ seatId, ticketType, halfPriceDocument }],
      userId,
    );
    return result;
  }

  /**
   * Creates a single booking covering every given seat in one Postgres
   * transaction: either all seats end up inserted, or none do. Without this,
   * a client booking several seats one call at a time can crash mid-loop and
   * leave some seats booked and others not, with no way to tell from the
   * response which ones made it — and a retry would hit the unique
   * `(session_id, seat_id)` constraint on the seats that already succeeded.
   */
  async createBookingForSeats(
    sessionId: string,
    seats: SeatChoice[],
    userId: string,
  ): Promise<CreateBookingResult[]> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    try {
      return await this.db.transaction(async (tx) => {
        const [booking] = await tx
          .insert(schema.bookings)
          .values({ userId, sessionId, status: "pending" })
          .returning();

        const results: CreateBookingResult[] = [];
        for (const seat of seats) {
          const priceCents =
            seat.ticketType === TicketType.HALF
              ? Math.round(session.priceCents * HALF_PRICE_RATIO)
              : session.priceCents;

          await tx.insert(schema.bookingSeats).values({
            bookingId: booking.id,
            sessionId,
            seatId: seat.seatId,
            ticketType: seat.ticketType,
            halfPriceDocument: seat.ticketType === TicketType.HALF ? seat.halfPriceDocument : null,
            priceCents,
          });

          results.push({
            bookingId: booking.id,
            seatId: seat.seatId,
            status: booking.status,
            ticketType: seat.ticketType,
            priceCents,
          });
        }
        return results;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("Um ou mais assentos já foram reservados para esta sessão");
      }
      throw err;
    }
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
