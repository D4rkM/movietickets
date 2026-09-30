import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CatalogModule } from "../src/catalog/catalog.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { buildFastifyApp } from "./helpers/build-app";

describe("Catalog (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;

  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let pastSessionId: string;
  let futureSessionId: string;
  let otherCinemaId: string;
  let otherRoomId: string;
  let otherCitySessionId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, CatalogModule],
    }).compile();

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "Catalog E2E Movie", durationMinutes: 100 })
      .returning({ id: schema.movies.id });

    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Catalog E2E Cinema", address: "Rua Teste, 2", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });

    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala Catalog E2E", rows: 1, seatsPerRow: 1 })
      .returning({ id: schema.rooms.id });

    const oneDayMs = 24 * 60 * 60 * 1000;
    [{ id: pastSessionId }] = await db
      .insert(schema.sessions)
      .values({
        movieId,
        roomId,
        startsAt: new Date(Date.now() - oneDayMs),
        priceCents: 1000,
      })
      .returning({ id: schema.sessions.id });

    [{ id: futureSessionId }] = await db
      .insert(schema.sessions)
      .values({
        movieId,
        roomId,
        startsAt: new Date(Date.now() + oneDayMs),
        priceCents: 2000,
      })
      .returning({ id: schema.sessions.id });

    [{ id: otherCinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Catalog E2E Cinema (other city)", address: "Rua Teste, 3", city: "Outra Cidade" })
      .returning({ id: schema.cinemas.id });
    [{ id: otherRoomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId: otherCinemaId, name: "Sala Catalog E2E (other)", rows: 1, seatsPerRow: 1 })
      .returning({ id: schema.rooms.id });
    [{ id: otherCitySessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId: otherRoomId, startsAt: new Date(Date.now() + oneDayMs), priceCents: 1500 })
      .returning({ id: schema.sessions.id });
  });

  afterAll(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, pastSessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, futureSessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, otherCitySessionId));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, otherRoomId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, cinemaId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, otherCinemaId));
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
    await cleanupClient.end();
    await app.close();
  });

  it("should list movies without requiring authentication", async () => {
    // GIVEN no Authorization header

    // WHEN the client requests the catalog
    const response = await app.inject({ method: "GET", url: "/movies" });

    // THEN it returns 200
    expect(response.statusCode).toBe(200);
  });

  it("should only include upcoming sessions for a movie", async () => {
    // GIVEN a movie with one past and one future session

    // WHEN the client requests the catalog
    const response = await app.inject({ method: "GET", url: "/movies" });

    // THEN the movie appears with only the future session
    const body = response.json();
    const movie = body.find((entry: { id: string }) => entry.id === movieId);
    expect(movie).toBeDefined();
    const sessionIds = movie.sessions.map((session: { id: string }) => session.id);
    expect(sessionIds).toContain(futureSessionId);
    expect(sessionIds).not.toContain(pastSessionId);
  });

  it("should filter sessions down to a single city, case-insensitively", async () => {
    // GIVEN sessions for the same movie split across two cities

    // WHEN the client filters by city (lowercased, unlike the stored "Testópolis")
    const response = await app.inject({ method: "GET", url: "/movies?city=testópolis" });

    // THEN only the session in that city shows, the other city's session is excluded
    const movie = response.json().find((entry: { id: string }) => entry.id === movieId);
    const sessionIds = movie.sessions.map((session: { id: string }) => session.id);
    expect(sessionIds).toContain(futureSessionId);
    expect(sessionIds).not.toContain(otherCitySessionId);
  });

  it("should filter sessions down to a single cinema by id", async () => {
    // GIVEN two cinemas showing the same movie

    // WHEN the client filters by the other cinema's id
    const response = await app.inject({ method: "GET", url: `/movies?cinemaId=${otherCinemaId}` });

    // THEN only that cinema's session shows
    const movie = response.json().find((entry: { id: string }) => entry.id === movieId);
    const sessionIds = movie.sessions.map((session: { id: string }) => session.id);
    expect(sessionIds).toEqual([otherCitySessionId]);
  });

  it("should drop a movie from the response entirely when no session matches the filter", async () => {
    // GIVEN a city with no cinemas at all

    // WHEN the client filters by that city
    const response = await app.inject({ method: "GET", url: "/movies?city=Cidade Inexistente" });

    // THEN the movie doesn't appear in the response at all
    const movie = response.json().find((entry: { id: string }) => entry.id === movieId);
    expect(movie).toBeUndefined();
  });

  it("should filter sessions down to a single calendar day", async () => {
    // GIVEN sessions at least one day apart

    // WHEN the client filters by the future session's exact date
    const dateStr = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await app.inject({ method: "GET", url: `/movies?date=${dateStr}` });

    // THEN sessions from other days are excluded — this movie has 2 sessions
    // on that date (Testópolis + Outra Cidade, both seeded +1 day out)
    const movie = response.json().find((entry: { id: string }) => entry.id === movieId);
    const sessionIds = movie.sessions.map((session: { id: string }) => session.id);
    expect(sessionIds.sort()).toEqual([futureSessionId, otherCitySessionId].sort());
  });

  it("should return 400 for an invalid cinemaId", async () => {
    // GIVEN a cinemaId that isn't a UUID

    // WHEN the client requests the catalog
    const response = await app.inject({ method: "GET", url: "/movies?cinemaId=not-a-uuid" });

    // THEN it returns 400
    expect(response.statusCode).toBe(400);
  });
});
