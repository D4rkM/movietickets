import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq, SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { Db } from "../shared/db.types";
import { AdminRoom } from "./admin-room.types";

@Injectable()
export class RoomQueriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Ordered by cinema name, then room name. */
  list(cinemaId?: string): Promise<AdminRoom[]> {
    return this.select(cinemaId ? eq(schema.rooms.cinemaId, cinemaId) : undefined);
  }

  async getById(id: string): Promise<AdminRoom> {
    const [room] = await this.select(eq(schema.rooms.id, id));
    if (!room) {
      throw new NotFoundException("Sala não encontrada");
    }
    return room;
  }

  private select(where: SQL | undefined): Promise<AdminRoom[]> {
    return this.db
      .select({
        id: schema.rooms.id,
        name: schema.rooms.name,
        rows: schema.rooms.rows,
        seatsPerRow: schema.rooms.seatsPerRow,
        cinemaId: schema.cinemas.id,
        cinemaName: schema.cinemas.name,
      })
      .from(schema.rooms)
      .innerJoin(schema.cinemas, eq(schema.rooms.cinemaId, schema.cinemas.id))
      .where(where)
      .orderBy(asc(schema.cinemas.name), asc(schema.rooms.name));
  }
}
