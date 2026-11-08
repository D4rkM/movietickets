import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq, gte, SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { Db } from "../shared/db.types";
import { AdminSession } from "./admin-session.types";
import { sessionInterval } from "./session-overlap";

@Injectable()
export class SessionQueriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Upcoming sessions by default (ordered by `startsAt`); `includePast` lists every session. */
  list(includePast = false): Promise<AdminSession[]> {
    return this.select(includePast ? undefined : gte(schema.sessions.startsAt, new Date()));
  }

  async getById(id: string): Promise<AdminSession> {
    const [session] = await this.select(eq(schema.sessions.id, id));
    if (!session) {
      throw new NotFoundException("Sessão não encontrada");
    }
    return session;
  }

  private async select(where: SQL | undefined): Promise<AdminSession[]> {
    const rows = await this.db
      .select({
        id: schema.sessions.id,
        startsAt: schema.sessions.startsAt,
        priceCents: schema.sessions.priceCents,
        movie: {
          id: schema.movies.id,
          title: schema.movies.title,
          durationMinutes: schema.movies.durationMinutes,
        },
        room: { id: schema.rooms.id, name: schema.rooms.name },
        cinema: { id: schema.cinemas.id, name: schema.cinemas.name },
      })
      .from(schema.sessions)
      .innerJoin(schema.movies, eq(schema.sessions.movieId, schema.movies.id))
      .innerJoin(schema.rooms, eq(schema.sessions.roomId, schema.rooms.id))
      .innerJoin(schema.cinemas, eq(schema.rooms.cinemaId, schema.cinemas.id))
      .where(where)
      .orderBy(asc(schema.sessions.startsAt));

    return rows.map((row) => ({
      ...row,
      startsAt: row.startsAt.toISOString(),
      endsAt: sessionInterval(row.startsAt, row.movie.durationMinutes).end.toISOString(),
    }));
  }
}
