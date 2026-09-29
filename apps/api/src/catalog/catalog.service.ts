import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, ilike, inArray, lt, SQL } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { CatalogMovie } from "./catalog.types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ListMoviesFilters {
  city?: string;
  cinemaId?: string;
  date?: string;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  async listMovies(filters: ListMoviesFilters = {}): Promise<CatalogMovie[]> {
    const hasFilters = Boolean(filters.city || filters.cinemaId || filters.date);
    const conditions: SQL[] = [gte(schema.sessions.startsAt, new Date())];

    if (filters.date) {
      const dayStart = new Date(`${filters.date}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);
      conditions.push(gte(schema.sessions.startsAt, dayStart), lt(schema.sessions.startsAt, dayEnd));
    }

    if (filters.city || filters.cinemaId) {
      const roomIds = await this.matchingRoomIds(filters.city, filters.cinemaId);
      if (roomIds.length === 0) {
        return [];
      }
      conditions.push(inArray(schema.sessions.roomId, roomIds));
    }

    const movies = await this.db.query.movies.findMany({
      with: {
        sessions: {
          where: and(...conditions),
          orderBy: asc(schema.sessions.startsAt),
          with: { room: { with: { cinema: true } } },
        },
      },
      orderBy: asc(schema.movies.title),
    });

    // Without filters, a movie with no upcoming sessions still shows (existing
    // catalog behavior). With filters, that would just be dead noise in the
    // filtered result, so those movies are dropped instead.
    const visibleMovies = hasFilters ? movies.filter((movie) => movie.sessions.length > 0) : movies;

    return visibleMovies.map((movie) => ({
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

  /** Resolves city/cinemaId filters to the set of room ids they match, so sessions can be filtered by `roomId`. */
  private async matchingRoomIds(city?: string, cinemaId?: string): Promise<string[]> {
    const cinemaConditions: SQL[] = [];
    if (cinemaId) {
      cinemaConditions.push(eq(schema.cinemas.id, cinemaId));
    }
    if (city) {
      cinemaConditions.push(ilike(schema.cinemas.city, city));
    }

    const cinemas = await this.db.query.cinemas.findMany({
      where: and(...cinemaConditions),
      with: { rooms: true },
    });

    return cinemas.flatMap((cinema) => cinema.rooms.map((room) => room.id));
  }
}
