import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Redis } from "ioredis";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { VALKEY } from "../valkey/valkey.module";
import {
  guestHoldMember,
  guestHoldsKey,
  guestIdFromHolder,
  HOLD_TTL_SECONDS,
  holdKey,
  MAX_HELD_SEATS_PER_USER,
  scanSessionHoldKeys,
  seatIdFromHoldKey,
} from "./hold-keys";
import { SeatingGateway } from "./seating.gateway";
import { SeatMapResponse, SeatState } from "./seat-map.types";

export { HOLD_KEY_PREFIX } from "./hold-keys";

export interface HoldSeatResult {
  seatId: string;
  status: "held";
  expiresInSeconds: number;
}

export interface ReleaseSeatResult {
  seatId: string;
  released: boolean;
}

export interface ReleaseAllHoldsResult {
  releasedSeatIds: string[];
}

/**
 * Every `userId` parameter below is the hold owner taken from the token's
 * `sub`: a user id, or `guest:<uuid>` for a guest. Both follow the same rules
 * (SETNX + TTL, 6 seats per session); guest holds are also indexed in
 * `guest-holds:<guestId>` so they can be transferred on login.
 */
@Injectable()
export class SeatingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly gateway: SeatingGateway,
  ) {}

  async getSeatMap(sessionId: string, userId: string): Promise<SeatMapResponse> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
      with: { room: { with: { seats: true } } },
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    const [bookedSeatIds, heldSeats] = await Promise.all([
      this.getBookedSeatIds(sessionId),
      this.getActiveHolds(sessionId),
    ]);

    const seats = [...session.room.seats]
      .sort((a, b) => a.rowLabel.localeCompare(b.rowLabel) || a.seatNumber - b.seatNumber)
      .map((seat) => ({
        id: seat.id,
        rowLabel: seat.rowLabel,
        seatNumber: seat.seatNumber,
        status: this.resolveStatus(seat.id, userId, bookedSeatIds, heldSeats),
      }));

    return {
      room: { rows: session.room.rows, seatsPerRow: session.room.seatsPerRow },
      priceCents: session.priceCents,
      seats,
    };
  }

  /**
   * Places a temporary hold on a seat for the requesting user (SETNX + TTL in
   * Valkey), so other users see it as unavailable while this one is in
   * checkout. Not the source of truth for double-booking — that's still the
   * unique `(session_id, seat_id)` constraint enforced at booking time.
   */
  async holdSeat(sessionId: string, seatId: string, userId: string): Promise<HoldSeatResult> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    const seat = await this.db.query.seats.findFirst({
      where: and(eq(schema.seats.id, seatId), eq(schema.seats.roomId, session.roomId)),
    });
    if (!seat) {
      throw new NotFoundException("Assento não encontrado nesta sessão");
    }

    if (await this.isSeatBooked(sessionId, seatId)) {
      throw new ConflictException("Assento já foi reservado");
    }

    const key = this.holdKey(sessionId, seatId);
    const currentHolder = await this.valkey.get(key);

    if (currentHolder === userId) {
      // Same user re-holding: treat as a TTL refresh instead of a conflict.
      await this.valkey.expire(key, HOLD_TTL_SECONDS);
      await this.trackGuestHolds(userId, sessionId, [seatId]);
      return { seatId, status: "held", expiresInSeconds: HOLD_TTL_SECONDS };
    }
    if (currentHolder) {
      throw new ConflictException("Assento já está sendo segurado por outro usuário");
    }

    const activeHolds = await this.countActiveHoldsForUser(sessionId, userId);
    if (activeHolds >= MAX_HELD_SEATS_PER_USER) {
      throw new ConflictException(
        `Limite de ${MAX_HELD_SEATS_PER_USER} assentos simultâneos por sessão atingido`,
      );
    }

    const acquired = await this.valkey.set(key, userId, "EX", HOLD_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      // Someone else won the race between the check above and this SETNX.
      throw new ConflictException("Assento já está sendo segurado por outro usuário");
    }
    await this.trackGuestHolds(userId, sessionId, [seatId]);

    this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "held", heldByUserId: userId });
    return { seatId, status: "held", expiresInSeconds: HOLD_TTL_SECONDS };
  }

  /**
   * Releases a single seat hold the requesting user owns — used when the
   * client backs out of a seat before finishing checkout. Idempotent and
   * silent when there's nothing to release (already expired, never held, or
   * held by someone else): a user can never release someone else's hold.
   */
  async releaseSeat(sessionId: string, seatId: string, userId: string): Promise<ReleaseSeatResult> {
    const session = await this.db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    });
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }

    const key = this.holdKey(sessionId, seatId);
    const currentHolder = await this.valkey.get(key);
    if (currentHolder !== userId) {
      return { seatId, released: false };
    }

    await this.valkey.del(key);
    await this.untrackGuestHolds(userId, sessionId, [seatId]);
    this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "released" });
    return { seatId, released: true };
  }

  /**
   * Releases every hold the requesting user has in a session — used when
   * they abandon the seat-selection/checkout flow entirely (back button,
   * navigating away, cancel confirmation) instead of backing out one seat at
   * a time.
   */
  async releaseAllHoldsForUser(sessionId: string, userId: string): Promise<ReleaseAllHoldsResult> {
    const keys = await this.scanHoldKeys(sessionId);
    if (keys.length === 0) {
      return { releasedSeatIds: [] };
    }

    const values = await this.valkey.mget(...keys);
    const ownedKeys = keys.filter((_, index) => values[index] === userId);
    if (ownedKeys.length === 0) {
      return { releasedSeatIds: [] };
    }

    await this.valkey.del(...ownedKeys);

    const releasedSeatIds = ownedKeys.map((key) => seatIdFromHoldKey(sessionId, key));
    await this.untrackGuestHolds(userId, sessionId, releasedSeatIds);
    for (const seatId of releasedSeatIds) {
      this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "released" });
    }
    return { releasedSeatIds };
  }

  /**
   * Clears the Valkey hold(s) for seats that just became a real `booking_seats`
   * row — called by BookingService right after creating a booking. From that
   * point on the Postgres unique `(session_id, seat_id)` constraint is what
   * guarantees exclusivity; a leftover hold is redundant and, if the booking
   * later gets cancelled within the hold's TTL, actively wrong: the seat would
   * read back as still held instead of free. No broadcast here — the booking
   * flow already emits its own "booked"/"released" events for this seat.
   */
  async releaseHoldsForBookedSeats(sessionId: string, seatIds: string[]): Promise<void> {
    if (seatIds.length === 0) return;
    const keys = seatIds.map((seatId) => this.holdKey(sessionId, seatId));
    await this.valkey.del(...keys);
  }

  private async isSeatBooked(sessionId: string, seatId: string): Promise<boolean> {
    const rows = await this.db.query.bookingSeats.findMany({
      where: and(eq(schema.bookingSeats.sessionId, sessionId), eq(schema.bookingSeats.seatId, seatId)),
      with: { booking: true },
    });
    return rows.some((row) => row.booking.status === "confirmed");
  }

  private async countActiveHoldsForUser(sessionId: string, userId: string): Promise<number> {
    const keys = await this.scanHoldKeys(sessionId);
    if (keys.length === 0) {
      return 0;
    }
    const values = await this.valkey.mget(...keys);
    return values.filter((value) => value === userId).length;
  }

  private holdKey(sessionId: string, seatId: string): string {
    return holdKey(sessionId, seatId);
  }

  /**
   * Keeps the `guest-holds:<guestId>` index in sync for guest holders (no-op
   * for users), so login can find a guest's holds without scanning every
   * session. The index TTL is renewed on each hold: it never needs to outlive
   * the newest hold it lists.
   */
  private async trackGuestHolds(holderId: string, sessionId: string, seatIds: string[]): Promise<void> {
    const guestId = guestIdFromHolder(holderId);
    if (!guestId || seatIds.length === 0) return;
    const indexKey = guestHoldsKey(guestId);
    await this.valkey
      .multi()
      .sadd(indexKey, ...seatIds.map((seatId) => guestHoldMember(sessionId, seatId)))
      .expire(indexKey, HOLD_TTL_SECONDS)
      .exec();
  }

  private async untrackGuestHolds(holderId: string, sessionId: string, seatIds: string[]): Promise<void> {
    const guestId = guestIdFromHolder(holderId);
    if (!guestId || seatIds.length === 0) return;
    await this.valkey.srem(guestHoldsKey(guestId), ...seatIds.map((seatId) => guestHoldMember(sessionId, seatId)));
  }

  private resolveStatus(
    seatId: string,
    userId: string,
    bookedSeatIds: Set<string>,
    heldSeats: Map<string, string>,
  ): SeatState {
    if (bookedSeatIds.has(seatId)) {
      return "booked";
    }
    const heldBy = heldSeats.get(seatId);
    if (heldBy === userId) {
      return "held_by_me";
    }
    if (heldBy) {
      return "held_by_other";
    }
    return "free";
  }

  private async getBookedSeatIds(sessionId: string): Promise<Set<string>> {
    const rows = await this.db.query.bookingSeats.findMany({
      where: eq(schema.bookingSeats.sessionId, sessionId),
      with: { booking: true },
    });
    return new Set(
      rows.filter((row) => row.booking.status === "confirmed").map((row) => row.seatId),
    );
  }

  private async getActiveHolds(sessionId: string): Promise<Map<string, string>> {
    const keys = await this.scanHoldKeys(sessionId);
    const holds = new Map<string, string>();
    if (keys.length === 0) {
      return holds;
    }

    const values = await this.valkey.mget(...keys);
    keys.forEach((key, index) => {
      const heldByUserId = values[index];
      if (heldByUserId) {
        const seatId = seatIdFromHoldKey(sessionId, key);
        holds.set(seatId, heldByUserId);
      }
    });
    return holds;
  }

  private scanHoldKeys(sessionId: string): Promise<string[]> {
    return scanSessionHoldKeys(this.valkey, sessionId);
  }
}
