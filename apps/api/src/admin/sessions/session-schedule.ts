import { and, eq, gt, lt, ne, SQL } from "drizzle-orm";
import * as schema from "../../db/schema";
import { MAX_MOVIE_DURATION_MINUTES } from "../movies/dto/movie.dto";
import { Tx } from "../shared/db.types";
import { intervalsOverlap, sessionInterval } from "./session-overlap";

const MS_PER_MINUTE = 60 * 1000;

export interface ScheduleCandidate {
  roomId: string;
  startsAt: Date;
  durationMinutes: number;
  /** The session being edited, so it isn't compared against itself. */
  excludeSessionId?: string;
  /** Duration to assume for every session of this movie (used while a movie's duration is being changed). */
  durationOverride?: { movieId: string; durationMinutes: number };
}

/**
 * Returns the id of a session in the same room whose interval overlaps the
 * candidate, past sessions included. Callers must hold the room lock (see
 * `lockRoom`) so two concurrent writes can't both pass this check.
 *
 * Only sessions starting within one maximum movie duration before the
 * candidate can reach into it, which bounds how many rows are read.
 */
export async function findOverlappingSession(tx: Tx, candidate: ScheduleCandidate): Promise<string | undefined> {
  const interval = sessionInterval(candidate.startsAt, candidate.durationMinutes);
  const earliestReachingStart = new Date(interval.start.getTime() - MAX_MOVIE_DURATION_MINUTES * MS_PER_MINUTE);

  const conditions: SQL[] = [
    eq(schema.sessions.roomId, candidate.roomId),
    lt(schema.sessions.startsAt, interval.end),
    gt(schema.sessions.startsAt, earliestReachingStart),
  ];
  if (candidate.excludeSessionId) {
    conditions.push(ne(schema.sessions.id, candidate.excludeSessionId));
  }

  const neighbours = await tx
    .select({
      id: schema.sessions.id,
      movieId: schema.sessions.movieId,
      startsAt: schema.sessions.startsAt,
      durationMinutes: schema.movies.durationMinutes,
    })
    .from(schema.sessions)
    .innerJoin(schema.movies, eq(schema.sessions.movieId, schema.movies.id))
    .where(and(...conditions));

  const override = candidate.durationOverride;
  const overlapping = neighbours.find((neighbour) => {
    const duration =
      override && neighbour.movieId === override.movieId ? override.durationMinutes : neighbour.durationMinutes;
    return intervalsOverlap(interval, sessionInterval(neighbour.startsAt, duration));
  });
  return overlapping?.id;
}
