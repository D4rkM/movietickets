import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { SeatingGateway } from "../seating/seating.gateway";
import {
  expirableBookingCondition,
  groupSeatsByBooking,
  IN_FLIGHT_PAYMENT_STATUSES,
  stalePaymentAlertCondition,
} from "./booking-lock";

export const SWEEP_INTERVAL_MS = 60_000;
export const SWEEP_BATCH_SIZE = 100;

export interface ExpiredBatch {
  bookings: { id: string; sessionId: string }[];
  seats: { bookingId: string; seatId: string }[];
}

export interface SweepResult {
  expiredBookingIds: string[];
  stalePaymentAlertBookingIds: string[];
}

/**
 * Periodically expires pending bookings past their deadline (with no payment
 * in flight), frees their seats and tells viewers of the seat map. Cleanup and
 * UX only: the seat map, holds and booking creation stay correct without it
 * (lazy check via `activeBookingCondition`/`expirableBookingCondition`).
 * Safe with several API instances: FOR UPDATE SKIP LOCKED plus the
 * conditional `status = 'pending'` UPDATE expire each booking exactly once,
 * and only the instance that expired it broadcasts.
 */
@Injectable()
export class PendingBookingSweeper {
  private readonly logger = new Logger(PendingBookingSweeper.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly gateway: SeatingGateway,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    await this.run();
  }

  /**
   * One sweeper tick. Skipped (returns undefined) while a previous tick on this
   * instance is still running; errors are logged, never thrown, so a failing
   * tick can't take the API down.
   */
  async run(): Promise<SweepResult | undefined> {
    if (this.running) {
      this.logger.debug("Previous sweep still running, skipping this tick");
      return undefined;
    }
    this.running = true;
    try {
      return await this.sweep();
    } catch (err) {
      this.logger.error(`Pending booking sweep failed: ${err}`);
      return undefined;
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<SweepResult> {
    const expiredBookingIds: string[] = [];
    for (;;) {
      const batch = await this.expireBatch();
      this.announce(batch);
      expiredBookingIds.push(...batch.bookings.map((booking) => booking.id));
      if (batch.bookings.length < SWEEP_BATCH_SIZE) break;
    }

    const stalePaymentAlertBookingIds = await this.alertStalePayments();
    return { expiredBookingIds, stalePaymentAlertBookingIds };
  }

  /** Expires up to {@link SWEEP_BATCH_SIZE} bookings and deletes their seats, in one transaction. */
  private expireBatch(): Promise<ExpiredBatch> {
    return this.db.transaction(async (tx) => {
      const candidates = tx
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(expirableBookingCondition())
        .orderBy(schema.bookings.expiresAt)
        .limit(SWEEP_BATCH_SIZE)
        .for("update", { skipLocked: true });

      const bookings = await tx
        .update(schema.bookings)
        .set({ status: "expired" })
        .where(and(inArray(schema.bookings.id, candidates), eq(schema.bookings.status, "pending")))
        .returning({ id: schema.bookings.id, sessionId: schema.bookings.sessionId });
      if (bookings.length === 0) return { bookings, seats: [] };

      const seats = await tx
        .delete(schema.bookingSeats)
        .where(
          inArray(
            schema.bookingSeats.bookingId,
            bookings.map((booking) => booking.id),
          ),
        )
        .returning({ bookingId: schema.bookingSeats.bookingId, seatId: schema.bookingSeats.seatId });
      return { bookings, seats };
    });
  }

  /** Runs after the batch transaction committed: one "released" per freed seat, plus an info log per booking. */
  private announce(batch: ExpiredBatch): void {
    const sessionByBooking = new Map(batch.bookings.map((booking) => [booking.id, booking.sessionId]));
    const seatsByBooking = groupSeatsByBooking(batch.seats);
    for (const booking of batch.bookings) {
      const seatIds = seatsByBooking.get(booking.id) ?? [];
      this.logger.log(
        `Pending booking expired (sweeper): bookingId=${booking.id} seatIds=${seatIds.join(",")}`,
      );
      for (const seatId of seatIds) {
        this.gateway.broadcastSeatUpdate(sessionByBooking.get(booking.id)!, { seatId, status: "released" });
      }
    }
  }

  /**
   * Flags, once per booking, pending bookings whose payment has been in flight
   * for more than 24h. The conditional UPDATE only returns a row to the first
   * caller (instance or tick), so the warning is logged exactly once.
   */
  private async alertStalePayments(): Promise<string[]> {
    const flagged = await this.db
      .update(schema.bookings)
      .set({ stalePaymentAlertedAt: sql`now()` })
      .where(stalePaymentAlertCondition())
      .returning({
        id: schema.bookings.id,
        paymentStatus: sql<string>`(select ${schema.payments.status} from ${schema.payments} where ${schema.payments.bookingId} = ${schema.bookings.id} and ${schema.payments.status} in (${sql.join(
          IN_FLIGHT_PAYMENT_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )}) limit 1)`,
      });

    for (const { id, paymentStatus } of flagged) {
      this.logger.warn(
        `Payment in flight for more than 24h, review: bookingId=${id} paymentStatus=${paymentStatus}`,
      );
    }
    return flagged.map((booking) => booking.id);
  }
}
