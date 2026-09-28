import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import Redis from "ioredis";
import postgres from "postgres";
import { AuthModule } from "../src/auth/auth.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { SeatingModule } from "../src/seating/seating.module";
import { ValkeyModule } from "../src/valkey/valkey.module";
import { buildFastifyApp } from "./helpers/build-app";

describe("Seating hold (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let valkey: Redis;
  let accessToken: string;
  let otherAccessToken: string;

  let userId: string;
  let otherUserId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;
  let seatId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, ValkeyModule, AuthModule, SeatingModule],
    }).compile();

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });
    valkey = new Redis(process.env.VALKEY_URL!);

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const jwtService = moduleRef.get(JwtService);

    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ name: "Seat Hold E2E User", email: "seat-hold-e2e@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });
    [{ id: otherUserId }] = await db
      .insert(schema.users)
      .values({ name: "Seat Hold E2E User 2", email: "seat-hold-e2e-2@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });

    accessToken = jwtService.sign({ sub: userId, email: "seat-hold-e2e@test.com", role: "customer" });
    otherAccessToken = jwtService.sign({ sub: otherUserId, email: "seat-hold-e2e-2@test.com", role: "customer" });

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "Seat Hold E2E Movie", durationMinutes: 90 })
      .returning({ id: schema.movies.id });
    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Seat Hold E2E Cinema", address: "Rua Teste, 1", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });
    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala Seat Hold E2E", rows: 1, seatsPerRow: 8 })
      .returning({ id: schema.rooms.id });
    [{ id: sessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId, startsAt: new Date(), priceCents: 3000 })
      .returning({ id: schema.sessions.id });
  });

  beforeEach(async () => {
    const [seat] = await db
      .insert(schema.seats)
      .values({ roomId, rowLabel: "A", seatNumber: Math.floor(Math.random() * 1_000_000) })
      .returning();
    seatId = seat.id;
  });

  // Each test in this file shares one session, so leftover holds from a
  // previous test would otherwise count toward the per-user seat-limit check
  // in the next one.
  afterEach(async () => {
    const keys = await valkey.keys(`seat-hold:${sessionId}:*`);
    if (keys.length > 0) {
      await valkey.del(...keys);
    }
  });

  afterAll(async () => {
    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, sessionId));
    await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    await db.delete(schema.seats).where(eq(schema.seats.roomId, roomId));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, cinemaId));
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    await cleanupClient.end();
    await valkey.quit();
    await app.close();
  });

  it("should reject holding a seat without a valid token", async () => {
    // GIVEN no Authorization header

    // WHEN the client calls POST /sessions/:id/seats/:seatId/hold
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
    });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });

  it("should return 404 for a seat that does not belong to the session's room", async () => {
    // GIVEN an authenticated user and a seat id that doesn't exist

    // WHEN the client tries to hold it
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/00000000-0000-0000-0000-0000000000ff/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 404
    expect(response.statusCode).toBe(404);
  });

  it("should hold a free seat and reflect it as held_by_me on the seat map", async () => {
    // GIVEN an authenticated user and a free seat

    // WHEN the client holds it
    const holdResponse = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 200 with a TTL, and the Valkey key is set with that TTL
    expect(holdResponse.statusCode).toBe(200);
    expect(holdResponse.json()).toEqual({ seatId, status: "held", expiresInSeconds: 600 });

    const ttl = await valkey.ttl(`seat-hold:${sessionId}:${seatId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    const seatMapResponse = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/seats`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const seat = seatMapResponse.json().seats.find((s: { id: string }) => s.id === seatId);
    expect(seat.status).toBe("held_by_me");
  });

  it("should reject a second user holding a seat already held by someone else", async () => {
    // GIVEN a seat already held by one user
    await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // WHEN a different user tries to hold the same seat
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${otherAccessToken}` },
    });

    // THEN it returns 409
    expect(response.statusCode).toBe(409);
  });

  it("should let the same user re-hold their own seat and refresh the TTL", async () => {
    // GIVEN a seat already held by this user
    await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // WHEN the same user holds it again
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it succeeds and the hold still belongs to this user
    expect(response.statusCode).toBe(200);
    const holder = await valkey.get(`seat-hold:${sessionId}:${seatId}`);
    expect(holder).toBe(userId);
  });

  it("should let only one of two concurrent holds on the same seat win", async () => {
    // GIVEN a free seat and two different users racing to hold it

    // WHEN both requests fire at the same time
    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/sessions/${sessionId}/seats/${seatId}/hold`,
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      app.inject({
        method: "POST",
        url: `/sessions/${sessionId}/seats/${seatId}/hold`,
        headers: { authorization: `Bearer ${otherAccessToken}` },
      }),
    ]);

    // THEN exactly one succeeds (200) and the other is rejected (409)
    const statusCodes = [firstResponse.statusCode, secondResponse.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);
  });

  it("should reject a 7th simultaneous hold from the same user in one session", async () => {
    // GIVEN this user already holds 6 seats in the session
    const seats = await db
      .insert(schema.seats)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          roomId,
          rowLabel: "Z",
          seatNumber: 100 + i,
        })),
      )
      .returning();
    for (const seat of seats) {
      const response = await app.inject({
        method: "POST",
        url: `/sessions/${sessionId}/seats/${seat.id}/hold`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(200);
    }

    // WHEN the same user tries to hold a 7th seat
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 409
    expect(response.statusCode).toBe(409);

    await db.delete(schema.seats).where(eq(schema.seats.rowLabel, "Z"));
  });
});
