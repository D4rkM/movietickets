import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Redis } from "ioredis";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { VALKEY } from "../valkey/valkey.module";
import { SeatMapResponse, SeatState } from "./seat-map.types";

const HOLD_KEY_PREFIX = "seat-hold";
const HOLD_TTL_SECONDS = 600;
const MAX_HELD_SEATS_PER_USER = 6;

export interface HoldSeatResult {
  seatId: string;
  status: "held";
  expiresInSeconds: number;
}

@Injectable()
export class SeatingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(VALKEY) private readonly valkey: Redis,
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

    return { seatId, status: "held", expiresInSeconds: HOLD_TTL_SECONDS };
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
    return `${HOLD_KEY_PREFIX}:${sessionId}:${seatId}`;
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
        const seatId = key.slice(`${HOLD_KEY_PREFIX}:${sessionId}:`.length);
        holds.set(seatId, heldByUserId);
      }
    });
    return holds;
  }

  private async scanHoldKeys(sessionId: string): Promise<string[]> {
    const pattern = `${HOLD_KEY_PREFIX}:${sessionId}:*`;
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, found] = await this.valkey.scan(cursor, "MATCH", pattern, "COUNT", 100);
      keys.push(...found);
      cursor = nextCursor;
    } while (cursor !== "0");
    return keys;
  }
}
