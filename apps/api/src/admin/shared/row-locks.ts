import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { Tx } from "./db.types";

/*
 * Row locks used to serialize admin writes that read-then-write. Lock order is
 * always session -> movie -> room, so two admin transactions never wait on
 * each other in a cycle.
 */

/** Locks the room row (FOR UPDATE); returns false when it doesn't exist. */
export async function lockRoom(tx: Tx, roomId: string): Promise<boolean> {
  const rows = await tx.select({ id: schema.rooms.id }).from(schema.rooms).where(eq(schema.rooms.id, roomId)).for("update");
  return rows.length > 0;
}

/**
 * Locks the movie row: FOR UPDATE when its duration is about to change, FOR
 * SHARE when a session for it is being scheduled (so the duration can't change
 * under the overlap check). Returns the movie's duration, or undefined when it
 * doesn't exist.
 */
export async function lockMovie(tx: Tx, movieId: string, mode: "update" | "share"): Promise<number | undefined> {
  const [row] = await tx
    .select({ durationMinutes: schema.movies.durationMinutes })
    .from(schema.movies)
    .where(eq(schema.movies.id, movieId))
    .for(mode);
  return row?.durationMinutes;
}

/**
 * Locks the session row (FOR UPDATE). This also blocks a concurrent booking
 * insert for it (the FK check takes a KEY SHARE lock on the session) until the
 * admin transaction ends.
 */
export async function lockSession(tx: Tx, sessionId: string): Promise<schema.Session | undefined> {
  const [row] = await tx.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).for("update");
  return row;
}
