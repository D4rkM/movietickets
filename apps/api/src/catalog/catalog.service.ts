import { Inject, Injectable } from "@nestjs/common";
import { asc, gte } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { CatalogMovie } from "./catalog.types";

@Injectable()
export class CatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  async listMovies(): Promise<CatalogMovie[]> {
    const movies = await this.db.query.movies.findMany({
      with: {
        sessions: {
          where: gte(schema.sessions.startsAt, new Date()),
          orderBy: asc(schema.sessions.startsAt),
          with: { room: { with: { cinema: true } } },
        },
      },
      orderBy: asc(schema.movies.title),
    });

    return movies.map((movie) => ({
      id: movie.id,
      title: movie.title,
      synopsis: movie.synopsis,
      durationMinutes: movie.durationMinutes,
      posterUrl: movie.posterUrl,
      rating: movie.rating,
      sessions: movie.sessions.map((session) => ({
        id: session.id,
        startsAt: session.startsAt.toISOString(),
        priceCents: session.priceCents,
        room: { id: session.room.id, name: session.room.name },
        cinema: {
          id: session.room.cinema.id,
          name: session.room.cinema.name,
          city: session.room.cinema.city,
        },
      })),
    }));
  }
}
