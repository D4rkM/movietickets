import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { SAMPLE_MOVIE_TITLE, seedSampleSession } from "../src/db/seed";
import * as schema from "../src/db/schema";

describe("seedSampleSession (e2e)", () => {
  let db: PostgresJsDatabase<typeof schema>;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    client = postgres(process.env.DATABASE_URL!);
    db = drizzle(client, { schema });

    // Start from a clean slate in case a previous `pnpm db:seed` run already
    // created this fixture (with its own already-booked seats) in the same
    // database.
    const existing = await db.query.movies.findFirst({ where: eq(schema.movies.title, SAMPLE_MOVIE_TITLE) });
    if (existing) {
      const existingSession = await db.query.sessions.findFirst({
        where: eq(schema.sessions.movieId, existing.id),
      });
      if (existingSession) {
        await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, existingSession.id));
        await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, existingSession.id));
      }
      await db.delete(schema.sessions).where(eq(schema.sessions.movieId, existing.id));
      await db.delete(schema.movies).where(eq(schema.movies.id, existing.id));
    }
  });

  afterAll(async () => {
    const movie = await db.query.movies.findFirst({ where: eq(schema.movies.title, SAMPLE_MOVIE_TITLE) });
    if (movie) {
      const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.movieId, movie.id) });
      if (session) {
        await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, session.id));
        await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, session.id));
      }
      const room = await db.query.rooms.findFirst({ where: eq(schema.rooms.id, session?.roomId ?? "") });
      await db.delete(schema.sessions).where(eq(schema.sessions.movieId, movie.id));
      await db.delete(schema.movies).where(eq(schema.movies.id, movie.id));
      if (room) {
        await db.delete(schema.seats).where(eq(schema.seats.roomId, room.id));
        await db.delete(schema.rooms).where(eq(schema.rooms.id, room.id));
        await db.delete(schema.cinemas).where(eq(schema.cinemas.id, room.cinemaId));
      }
    }
    await client.end();
  });

  it("should re-roll an existing session's startsAt into the future on a later run instead of leaving it stale", async () => {
    // GIVEN a first seed run that created the sample session
    const sessionId = await seedSampleSession(db);

    // and its startsAt was artificially pushed into the past, simulating a
    // session that aged out since the last seed run
    const staleDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.update(schema.sessions).set({ startsAt: staleDate }).where(eq(schema.sessions.id, sessionId));

    // WHEN the seed runs again
    const secondRunSessionId = await seedSampleSession(db);

    // THEN it reuses the same session (no duplicate movie/session created) and
    // its startsAt was moved back into the 3-7 day future window
    expect(secondRunSessionId).toBe(sessionId);

    const updated = await db.query.sessions.findFirst({ where: eq(schema.sessions.id, sessionId) });
    const minMs = Date.now() + 3 * 24 * 60 * 60 * 1000 - 1000;
    const maxMs = Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000;
    expect(updated!.startsAt.getTime()).toBeGreaterThanOrEqual(minMs);
    expect(updated!.startsAt.getTime()).toBeLessThanOrEqual(maxMs);

    const movies = await db.query.movies.findMany({ where: eq(schema.movies.title, SAMPLE_MOVIE_TITLE) });
    expect(movies).toHaveLength(1);
  });
});
