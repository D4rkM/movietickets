import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { NotificationService } from "../notification/notification.service";
import { SeatingGateway } from "../seating/seating.gateway";
import { SeatingService } from "../seating/seating.service";
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
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly gateway: SeatingGateway,
    private readonly seatingService: SeatingService,
    private readonly notificationService: NotificationService,
  ) {}

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

    let results: CreateBookingResult[];
    try {
      results = await this.db.transaction(async (tx) => {
        const [booking] = await tx
          .insert(schema.bookings)
          .values({ userId, sessionId, status: "pending" })
          .returning();

        const txResults: CreateBookingResult[] = [];
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

          txResults.push({
            bookingId: booking.id,
            seatId: seat.seatId,
            status: booking.status,
            ticketType: seat.ticketType,
            priceCents,
          });
        }
        return txResults;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("Um ou mais assentos já foram reservados para esta sessão");
      }
      throw err;
    }

    // The Postgres unique (session_id, seat_id) constraint is what guarantees
    // exclusivity from here on — any Valkey hold on these seats is now
    // redundant, and if left in place would make a later cancellation show
    // the seat as still held instead of free (see hold-expiry.listener.ts's
    // sibling bug: orphaned holds lying around after the fact they were meant
    // to protect no longer matters).
    await this.seatingService.releaseHoldsForBookedSeats(
      sessionId,
      seats.map((seat) => seat.seatId),
    );

    return results;
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

    const bookedSeats = await this.db.query.bookingSeats.findMany({
      where: eq(schema.bookingSeats.bookingId, bookingId),
    });
    for (const seat of bookedSeats) {
      this.gateway.broadcastSeatUpdate(updated.sessionId, { seatId: seat.seatId, status: "booked" });
    }
    await this.sendConfirmationEmail(bookingId);

    return { bookingId: updated.id, status: updated.status };
  }

  /**
   * Releases a booking after Mercado Pago reports the payment failed (rejected/cancelled/expired).
   * `booking_seats` has an unconditional unique `(session_id, seat_id)` constraint, so a pending
   * booking that's never cleaned up blocks that exact seat from ever being booked again — even
   * though it doesn't show as "booked" on the seat map (that only counts confirmed bookings).
   * Deleting the seat rows is what actually frees the seat up for a retry; idempotent like
   * {@link confirmPaidBooking} for the same redelivery reason.
   */
  async releaseFailedPaymentBooking(bookingId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.status, "pending")))
        .returning();
      if (!updated) return;

      await tx.delete(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, bookingId));
    });
  }

  /**
   * Confirms a booking after Mercado Pago reports an approved payment. Idempotent:
   * webhooks can be redelivered, so a booking that is already past `pending` is left alone.
   */
  async confirmPaidBooking(bookingId: string): Promise<void> {
    const [updated] = await this.db
      .update(schema.bookings)
      .set({ status: "confirmed" })
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.status, "pending")))
      .returning();
    if (!updated) return;

    const bookedSeats = await this.db.query.bookingSeats.findMany({
      where: eq(schema.bookingSeats.bookingId, bookingId),
    });
    for (const seat of bookedSeats) {
      this.gateway.broadcastSeatUpdate(updated.sessionId, { seatId: seat.seatId, status: "booked" });
    }
    await this.sendConfirmationEmail(bookingId);
  }

  /**
   * Self-service cancellation: only a confirmed booking's owner can cancel
   * it. Flips the booking to `cancelled` (its seats stop counting as booked,
   * per `isSeatBooked`/`getBookedSeatIds`, which only look at `confirmed`
   * bookings) and broadcasts each seat back to "released" so other clients
   * watching that session's seat map see them free up in real time.
   */
  async cancelBooking(bookingId: string, userId: string): Promise<ConfirmBookingResult> {
    const booking = await this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
    });
    if (!booking || booking.userId !== userId) {
      throw new NotFoundException("Reserva não encontrada");
    }
    if (booking.status !== "confirmed") {
      throw new ConflictException(`Reserva já está com status "${booking.status}"`);
    }

    const [updated] = await this.db
      .update(schema.bookings)
      .set({ status: "cancelled" })
      .where(eq(schema.bookings.id, bookingId))
      .returning();

    const cancelledSeats = await this.db.query.bookingSeats.findMany({
      where: eq(schema.bookingSeats.bookingId, bookingId),
    });
    for (const seat of cancelledSeats) {
      this.gateway.broadcastSeatUpdate(updated.sessionId, { seatId: seat.seatId, status: "released" });
    }

    return { bookingId: updated.id, status: updated.status };
  }

  /**
   * Best-effort purchase-confirmation email, fired from both confirmation paths
   * (mocked self-service confirm and the real Mercado Pago webhook). Swallows
   * failures so a flaky SMTP connection never blocks the booking itself from
   * being confirmed — the seat is already booked by this point regardless.
   */
  private async sendConfirmationEmail(bookingId: string): Promise<void> {
    const booking = await this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
      with: {
        user: true,
        session: { with: { movie: true, room: { with: { cinema: true } } } },
        seats: { with: { seat: true } },
      },
    });
    if (!booking) return;

    try {
      await this.notificationService.sendBookingConfirmationEmail({
        to: booking.user.email,
        bookingId: booking.id,
        movieTitle: booking.session.movie.title,
        cinemaName: booking.session.room.cinema.name,
        roomName: booking.session.room.name,
        startsAt: booking.session.startsAt,
        seats: booking.seats.map((bookingSeat) => ({
          rowLabel: bookingSeat.seat.rowLabel,
          seatNumber: bookingSeat.seat.seatNumber,
        })),
        totalCents: booking.seats.reduce((sum, bookingSeat) => sum + bookingSeat.priceCents, 0),
      });
    } catch (err) {
      this.logger.warn(`Failed to send booking confirmation email for ${bookingId}: ${err}`);
    }
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
