import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Redis } from "ioredis";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { VALKEY } from "../valkey/valkey.module";
import { SeatMapResponse, SeatState } from "./seat-map.types";

const HOLD_KEY_PREFIX = "seat-hold";

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
