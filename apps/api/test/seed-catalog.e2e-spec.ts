import { eq, inArray } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CATALOG_MOVIE_TITLES, seedCatalogMovies } from "../src/db/seed";
import * as schema from "../src/db/schema";

describe("seedCatalogMovies (e2e)", () => {
  let db: PostgresJsDatabase<typeof schema>;
  let client: ReturnType<typeof postgres>;

  async function cleanup(): Promise<void> {
    const movies = await db.query.movies.findMany({ where: inArray(schema.movies.title, CATALOG_MOVIE_TITLES) });
    for (const movie of movies) {
      const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.movieId, movie.id) });
      if (session) {
        await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, session.id));
        await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, session.id));
      }
      const room = session ? await db.query.rooms.findFirst({ where: eq(schema.rooms.id, session.roomId) }) : null;
      await db.delete(schema.sessions).where(eq(schema.sessions.movieId, movie.id));
      await db.delete(schema.movies).where(eq(schema.movies.id, movie.id));
      if (room) {
        await db.delete(schema.seats).where(eq(schema.seats.roomId, room.id));
        await db.delete(schema.rooms).where(eq(schema.rooms.id, room.id));
        await db.delete(schema.cinemas).where(eq(schema.cinemas.id, room.cinemaId));
      }
    }
  }

  beforeAll(async () => {
    client = postgres(process.env.DATABASE_URL!);
    db = drizzle(client, { schema });

    // Start from a clean slate in case a previous `pnpm db:seed` run already
    // created these fixtures in the same database.
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  it("should create one movie/cinema/session per catalog title, each with a session starting 1 hour to 7 days out", async () => {
    // GIVEN no catalog demo movies exist yet (ensured by beforeAll's cleanup)

    // WHEN the catalog seed runs
    await seedCatalogMovies(db);

    // THEN every title got exactly one movie with one future session
    const movies = await db.query.movies.findMany({ where: inArray(schema.movies.title, CATALOG_MOVIE_TITLES) });
    expect(movies).toHaveLength(CATALOG_MOVIE_TITLES.length);

    const minMs = Date.now() + 60 * 60 * 1000 - 1000;
    const maxMs = Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000;

    for (const movie of movies) {
      const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.movieId, movie.id) });
      expect(session).toBeDefined();
      expect(session!.startsAt.getTime()).toBeGreaterThanOrEqual(minMs);
      expect(session!.startsAt.getTime()).toBeLessThanOrEqual(maxMs);
    }
  });

  it("should reuse existing movies/sessions on a later run instead of creating duplicates", async () => {
    // GIVEN a first seed run that already created the catalog movies
    await seedCatalogMovies(db);
    const firstRunMovies = await db.query.movies.findMany({
      where: inArray(schema.movies.title, CATALOG_MOVIE_TITLES),
    });
    const firstRunSession = await db.query.sessions.findFirst({
      where: eq(schema.sessions.movieId, firstRunMovies[0].id),
    });

    // and that session's startsAt was artificially pushed into the past,
    // simulating a session that aged out since the last seed run
    const staleDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.update(schema.sessions).set({ startsAt: staleDate }).where(eq(schema.sessions.id, firstRunSession!.id));

    // WHEN the seed runs again
    await seedCatalogMovies(db);

    // THEN no duplicate movies were created
    const secondRunMovies = await db.query.movies.findMany({
      where: inArray(schema.movies.title, CATALOG_MOVIE_TITLES),
    });
    expect(secondRunMovies).toHaveLength(CATALOG_MOVIE_TITLES.length);

    // and the stale session was reused and re-rolled back into the future
    const updatedSession = await db.query.sessions.findFirst({
      where: eq(schema.sessions.movieId, firstRunMovies[0].id),
    });
    expect(updatedSession!.id).toBe(firstRunSession!.id);
    expect(updatedSession!.startsAt.getTime()).toBeGreaterThan(Date.now());
  });
});
