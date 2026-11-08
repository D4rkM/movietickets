import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import { isForeignKeyViolation } from "../../db/pg-errors";
import * as schema from "../../db/schema";
import { Db, Tx } from "../shared/db.types";
import { definedFields } from "../shared/defined-fields";
import { lockMovie, lockRoom } from "../shared/row-locks";
import { findOverlappingSession } from "../sessions/session-schedule";
import { AdminMovie, toAdminMovie } from "./admin-movie.types";
import { CreateMovieDto, UpdateMovieDto } from "./dto/movie.dto";

const MOVIE_HAS_SESSIONS = "Filme tem sessões cadastradas e não pode ser excluído";

@Injectable()
export class MovieCommandsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(dto: CreateMovieDto): Promise<AdminMovie> {
    const [movie] = await this.db
      .insert(schema.movies)
      .values({
        title: dto.title,
        synopsis: dto.synopsis ?? null,
        durationMinutes: dto.durationMinutes,
        posterUrl: dto.posterUrl ?? null,
        rating: dto.rating ?? null,
      })
      .returning();
    return toAdminMovie(movie);
  }

  async update(id: string, dto: UpdateMovieDto): Promise<AdminMovie> {
    return this.db.transaction(async (tx) => {
      const currentDuration = await lockMovie(tx, id, "update");
      if (currentDuration === undefined) {
        throw new NotFoundException("Filme não encontrado");
      }
      if (dto.durationMinutes !== undefined && dto.durationMinutes !== currentDuration) {
        await this.assertNewDurationFits(tx, id, dto.durationMinutes);
      }

      const changes = definedFields(dto);
      const [movie] =
        Object.keys(changes).length > 0
          ? await tx.update(schema.movies).set(changes).where(eq(schema.movies.id, id)).returning()
          : await tx.select().from(schema.movies).where(eq(schema.movies.id, id));
      return toAdminMovie(movie);
    });
  }

  async delete(id: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        if ((await lockMovie(tx, id, "update")) === undefined) {
          throw new NotFoundException("Filme não encontrado");
        }
        const [session] = await tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.movieId, id))
          .limit(1);
        if (session) {
          throw new ConflictException(MOVIE_HAS_SESSIONS);
        }
        await tx.delete(schema.movies).where(eq(schema.movies.id, id));
      });
    } catch (err) {
      // A session created between the check and the delete still trips the FK.
      if (isForeignKeyViolation(err)) throw new ConflictException(MOVIE_HAS_SESSIONS);
      throw err;
    }
  }

  /**
   * Every future session of the movie must still fit in its room with the new
   * duration. Rooms are locked in id order so concurrent writers on the same
   * rooms can't deadlock.
   */
  private async assertNewDurationFits(tx: Tx, movieId: string, durationMinutes: number): Promise<void> {
    const futureSessions = await tx
      .select({ id: schema.sessions.id, roomId: schema.sessions.roomId, startsAt: schema.sessions.startsAt })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.movieId, movieId), gt(schema.sessions.startsAt, new Date())))
      .orderBy(asc(schema.sessions.startsAt));

    const roomIds = [...new Set(futureSessions.map((session) => session.roomId))].sort();
    for (const roomId of roomIds) {
      await lockRoom(tx, roomId);
    }

    for (const session of futureSessions) {
      const overlappingId = await findOverlappingSession(tx, {
        roomId: session.roomId,
        startsAt: session.startsAt,
        durationMinutes,
        excludeSessionId: session.id,
        durationOverride: { movieId, durationMinutes },
      });
      if (overlappingId) {
        throw new ConflictException("Com a nova duração, uma sessão deste filme se sobrepõe a outra sessão na mesma sala");
      }
    }
  }
}
