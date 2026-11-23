import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import { isUniqueViolation } from "../db/pg-errors";
import * as schema from "../db/schema";
import { NotificationService } from "../notification/notification.service";
import { SeatingGateway } from "../seating/seating.gateway";
import { SeatingService } from "../seating/seating.service";
import { BusinessMetrics } from "../telemetry/business-metrics";
import {
  assertBookingNotExpired,
  BookingAlreadyPendingException,
  BookingExpiredException,
} from "./booking-expired.exception";
import { parseSeatLabel, toCustomerRefundStatus } from "../refund/refund-status";
import {
  cancellableUntil,
  expirableBookingCondition,
  groupSeatsByBooking,
  notPastDeadline,
  pastDeadline,
  pendingBookingExpiresAt,
} from "./booking-lock";
import { TicketType } from "./dto/book-seat.dto";
import { MyBooking } from "./my-booking.types";

const HALF_PRICE_RATIO = 0.5;

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

/** Which payment path confirmed the booking (metric `confirmation.source`). */
export type PaidConfirmationSource = "payment_sync" | "payment_webhook";

export interface ApprovedPayment {
  externalPaymentId: string;
  amountCents: number;
}

export interface PaidBookingConfirmation {
  confirmed: boolean;
  notify: () => Promise<void>;
}

export interface ConfirmBookingResult {
  bookingId: string;
  status: string;
}

type DbExecutor = Pick<PostgresJsDatabase<typeof schema>, "update">;

export type BookingCancellationExecutor = Pick<PostgresJsDatabase<typeof schema>, "select" | "update" | "delete">;

export interface BookingCancellation {
  /** False when the booking wasn't `confirmed` anymore (nothing changed). */
  cancelled: boolean;
  seatLabels: string[];
  releasedSeatIds: string[];
  /** Post-commit `released` broadcast, one per freed seat. */
  notify: () => Promise<void>;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly gateway: SeatingGateway,
    private readonly seatingService: SeatingService,
    private readonly notificationService: NotificationService,
    private readonly metrics: BusinessMetrics,
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

    const requestedSeatIds = seats.map((seat) => seat.seatId);
    let results: CreateBookingResult[];
    let expiredSeats: { bookingId: string; seatId: string }[] = [];
    let expiredBookingCount = 0;
    try {
      results = await this.db.transaction(async (tx) => {
        // Lazy expiry: a pending booking past its deadline (and with no payment in
        // flight) that conflicts with the requested seats is expired here, in the
        // same transaction, so the seats don't depend on the sweeper having run.
        // The conditional UPDATE locks the old booking row: a concurrent creation
        // waits, re-checks `status = 'pending'`, no longer matches and falls through
        // to the insert, where the unique constraint picks a single winner.
        const expiredBookings = await tx
          .update(schema.bookings)
          .set({ status: "expired" })
          .where(
            and(
              expirableBookingCondition(),
              inArray(
                schema.bookings.id,
                tx
                  .select({ bookingId: schema.bookingSeats.bookingId })
                  .from(schema.bookingSeats)
                  .where(
                    and(
                      eq(schema.bookingSeats.sessionId, sessionId),
                      inArray(schema.bookingSeats.seatId, requestedSeatIds),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: schema.bookings.id });
        expiredBookingCount = expiredBookings.length;
        if (expiredBookings.length > 0) {
          // Every seat of an expired booking is freed, not only the requested ones.
          expiredSeats = await tx
            .delete(schema.bookingSeats)
            .where(
              inArray(
                schema.bookingSeats.bookingId,
                expiredBookings.map((booking) => booking.id),
              ),
            )
            .returning({ bookingId: schema.bookingSeats.bookingId, seatId: schema.bookingSeats.seatId });
        }

        const [booking] = await tx
          .insert(schema.bookings)
          .values({ userId, sessionId, status: "pending", expiresAt: pendingBookingExpiresAt() })
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
        const existingBookingId = await this.findOwnPendingBookingForExactSeats(
          sessionId,
          userId,
          requestedSeatIds,
        );
        if (existingBookingId) {
          throw new BookingAlreadyPendingException(existingBookingId);
        }
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
    await this.seatingService.releaseHoldsForBookedSeats(sessionId, requestedSeatIds);

    // Only reached after the transaction committed.
    this.metrics.bookingCreated(seats.length);
    this.metrics.bookingExpired("lazy", expiredBookingCount);
    this.logExpiredSeats("lazy expiry on booking creation", expiredSeats);
    for (const { seatId } of expiredSeats) {
      if (!requestedSeatIds.includes(seatId)) {
        this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "released" });
      }
    }
    // A pending booking within its deadline shows as "booked" on the seat map,
    // so viewers with the map open get the same state without refetching.
    for (const seatId of requestedSeatIds) {
      this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "booked" });
    }

    return results;
  }

  /**
   * Mocked payment confirmation: flips a pending booking to confirmed so it
   * shows as "booked" on the seat map. Real payment gateway integration and
   * seat-conflict handling land in a later story. Refuses (409
   * BOOKING_EXPIRED) a booking that is expired or past its deadline.
   */
  async confirmBooking(bookingId: string, userId: string): Promise<ConfirmBookingResult> {
    const booking = await this.findBookingWithDeadline(bookingId);
    if (!booking || booking.userId !== userId) {
      throw new NotFoundException("Reserva não encontrada");
    }
    this.assertConfirmable(booking);

    // Re-checks status and deadline atomically, so a booking that expired (or got
    // swept/confirmed) between the read above and this write is never confirmed.
    const [updated] = await this.db
      .update(schema.bookings)
      .set({ status: "confirmed" })
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.status, "pending"), notPastDeadline()))
      .returning();
    if (!updated) {
      const current = await this.findBookingWithDeadline(bookingId);
      if (current) this.assertConfirmable(current);
      throw new BookingExpiredException();
    }
    this.metrics.bookingConfirmed("mock");

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
   * Confirms a booking after Mercado Pago reports an approved payment. Idempotent:
   * webhooks can be redelivered, so a booking that is already past `pending` is left alone.
   * A pending booking is confirmed even past its deadline: it was only kept alive
   * because this payment was in flight. An `expired` booking is never revived (its
   * seats may belong to someone else by now): it's flagged for manual refund review
   * instead, once.
   *
   * When `tx` is provided, the database state change runs inside `tx` and the returned
   * `notify` callback must be awaited by the caller after `tx` commits so WebSocket
   * broadcasts and confirmation emails are never sent for a rolled-back transaction.
   */
  async confirmPaidBooking(
    bookingId: string,
    payment?: ApprovedPayment,
    tx?: DbExecutor,
    source: PaidConfirmationSource = "payment_webhook",
  ): Promise<PaidBookingConfirmation> {
    const executor = tx ?? this.db;
    const [updated] = await executor
      .update(schema.bookings)
      .set({ status: "confirmed" })
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.status, "pending")))
      .returning();
    if (!updated) {
      const flagged = await this.flagExpiredBookingForRefundReview(bookingId, payment, executor);
      const notifyFlagged = async () => {
        if (flagged) this.metrics.bookingRefundReviewFlagged();
      };
      if (!tx) {
        await notifyFlagged();
      }
      return { confirmed: false, notify: notifyFlagged };
    }

    const notify = async () => {
      // Runs only after the caller's transaction committed (or right away without one).
      this.metrics.bookingConfirmed(source);
      const bookedSeats = await this.db.query.bookingSeats.findMany({
        where: eq(schema.bookingSeats.bookingId, bookingId),
      });
      for (const seat of bookedSeats) {
        this.gateway.broadcastSeatUpdate(updated.sessionId, { seatId: seat.seatId, status: "booked" });
      }
      await this.sendConfirmationEmail(bookingId);
    };

    if (!tx) {
      await notify();
    }
    return { confirmed: true, notify };
  }

  /**
   * Cancels a `confirmed` booking inside the caller's transaction and frees its
   * seats the same way expiry does: snapshots the seat labels into
   * `bookings.cancelled_seat_labels`, then deletes its `booking_seats` rows (so
   * the unique `(session_id, seat_id)` constraint no longer blocks re-booking).
   * Conditional on `status = 'confirmed'`, so a second call is a no-op.
   *
   * The returned `notify` broadcasts `released` per freed seat and must be
   * awaited by the caller only after `tx` commits.
   */
  async cancelConfirmedBooking(tx: BookingCancellationExecutor, bookingId: string): Promise<BookingCancellation> {
    const seatRows = await tx
      .select({
        seatId: schema.bookingSeats.seatId,
        rowLabel: schema.seats.rowLabel,
        seatNumber: schema.seats.seatNumber,
      })
      .from(schema.bookingSeats)
      .innerJoin(schema.seats, eq(schema.seats.id, schema.bookingSeats.seatId))
      .where(eq(schema.bookingSeats.bookingId, bookingId))
      .orderBy(asc(schema.seats.rowLabel), asc(schema.seats.seatNumber));
    const seatLabels = seatRows.map((row) => `${row.rowLabel}${row.seatNumber}`);

    const [cancelled] = await tx
      .update(schema.bookings)
      .set({ status: "cancelled", cancelledSeatLabels: seatLabels })
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.status, "confirmed")))
      .returning({ sessionId: schema.bookings.sessionId });
    if (!cancelled) {
      return { cancelled: false, seatLabels: [], releasedSeatIds: [], notify: async () => undefined };
    }

    const released = await tx
      .delete(schema.bookingSeats)
      .where(eq(schema.bookingSeats.bookingId, bookingId))
      .returning({ seatId: schema.bookingSeats.seatId });
    const releasedSeatIds = released.map((row) => row.seatId);

    const notify = async () => {
      this.metrics.bookingCancelled();
      for (const seatId of releasedSeatIds) {
        this.gateway.broadcastSeatUpdate(cancelled.sessionId, { seatId, status: "released" });
      }
    };
    return { cancelled: true, seatLabels, releasedSeatIds, notify };
  }

  private findBookingWithDeadline(bookingId: string) {
    return this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
      extras: (table) => ({ pastDeadline: pastDeadline(table.expiresAt).as("past_deadline") }),
    });
  }

  private assertConfirmable(booking: { status: string; pastDeadline: boolean }): void {
    assertBookingNotExpired(booking);
    if (booking.status !== "pending") {
      throw new ConflictException(`Reserva já está com status "${booking.status}"`);
    }
  }

  /**
   * Finds the user's own active `pending` booking for `sessionId` when its seat
   * set matches `requestedSeatIds` one-for-one. Returns `undefined` when the
   * conflict comes from another user, a confirmed booking, or a partial seat overlap.
   */
  private async findOwnPendingBookingForExactSeats(
    sessionId: string,
    userId: string,
    requestedSeatIds: string[],
  ): Promise<string | undefined> {
    const pendingBookings = await this.db.query.bookings.findMany({
      where: and(
        eq(schema.bookings.sessionId, sessionId),
        eq(schema.bookings.userId, userId),
        eq(schema.bookings.status, "pending"),
        notPastDeadline(),
      ),
      with: { seats: true },
    });
    if (!Array.isArray(pendingBookings)) return undefined;

    const requestedSet = new Set(requestedSeatIds);
    const matches = pendingBookings.filter((booking) => {
      if (booking.seats.length !== requestedSet.size) return false;
      return booking.seats.every((seat) => requestedSet.has(seat.seatId));
    });
    return matches.length === 1 ? matches[0].id : undefined;
  }

  /**
   * Flags an `expired` booking that received an approved payment for manual
   * refund review. The conditional update only matches the first time, so a
   * redelivered webhook neither changes anything nor repeats the warning.
   * Returns whether the booking was flagged by this call.
   */
  private async flagExpiredBookingForRefundReview(
    bookingId: string,
    payment?: ApprovedPayment,
    executor: DbExecutor = this.db,
  ): Promise<boolean> {
    const [flagged] = await executor
      .update(schema.bookings)
      .set({ needsRefundReview: true })
      .where(
        and(
          eq(schema.bookings.id, bookingId),
          eq(schema.bookings.status, "expired"),
          eq(schema.bookings.needsRefundReview, false),
        ),
      )
      .returning({ id: schema.bookings.id });
    if (!flagged) return false;

    this.logger.warn(
      `Approved payment on an expired booking, review refund: bookingId=${bookingId} ` +
        `externalPaymentId=${payment?.externalPaymentId ?? "unknown"} amountCents=${payment?.amountCents ?? "unknown"}`,
    );
    return true;
  }

  private logExpiredSeats(reason: string, expiredSeats: { bookingId: string; seatId: string }[]): void {
    const seatsByBooking = groupSeatsByBooking(expiredSeats);
    for (const [bookingId, seatIds] of seatsByBooking) {
      this.logger.log(`Pending booking expired (${reason}): bookingId=${bookingId} seatIds=${seatIds.join(",")}`);
    }
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
      this.metrics.confirmationEmail("sent");
    } catch (err) {
      this.metrics.confirmationEmail("failed");
      this.logger.warn(`Failed to send booking confirmation email for ${bookingId}: ${err}`);
    }
  }

  /**
   * Lists the authenticated user's bookings, most recent first: every
   * `confirmed` one, plus `cancelled`/`expired` ones that have at least one
   * refund (a cancelled booking that was never paid for stays hidden).
   */
  async getMyBookings(userId: string): Promise<MyBooking[]> {
    const bookings = await this.db.query.bookings.findMany({
      where: and(
        eq(schema.bookings.userId, userId),
        inArray(schema.bookings.status, ["confirmed", "cancelled", "expired"]),
      ),
      orderBy: desc(schema.bookings.createdAt),
      with: {
        session: { with: { movie: true, room: { with: { cinema: true } } } },
        seats: { with: { seat: true } },
        refunds: { orderBy: (refunds, { desc: descending }) => [descending(refunds.createdAt)] },
      },
    });

    return bookings
      .filter((booking) => booking.status === "confirmed" || booking.refunds.length > 0)
      .map((booking) => {
        const lastRefund = booking.refunds[0];
        const hasSeatRows = booking.seats.length > 0;
        return {
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
          seats: hasSeatRows
            ? booking.seats.map((bookingSeat) => ({
                rowLabel: bookingSeat.seat.rowLabel,
                seatNumber: bookingSeat.seat.seatNumber,
              }))
            : (booking.cancelledSeatLabels ?? []).map(parseSeatLabel),
          amountCents: hasSeatRows
            ? booking.seats.reduce((sum, bookingSeat) => sum + bookingSeat.priceCents, 0)
            : (lastRefund?.amountCents ?? 0),
          cancellableUntil: cancellableUntil(booking.session.startsAt).toISOString(),
          refund: lastRefund
            ? {
                status: toCustomerRefundStatus(lastRefund.status),
                amountCents: lastRefund.amountCents,
                requestedAt: lastRefund.createdAt.toISOString(),
              }
            : null,
        };
      });
  }
}
