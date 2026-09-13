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

describe("Seating (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let valkey: Redis;
  let accessToken: string;

  const otherUserId = "00000000-0000-0000-0000-000000000002";
  let userId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;
  let seatIds: string[];

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

    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ name: "Seating E2E User", email: "seating-e2e@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });

    accessToken = moduleRef
      .get(JwtService)
      .sign({ sub: userId, email: "seating-e2e@test.com", role: "customer" });

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "Seating E2E Movie", durationMinutes: 120 })
      .returning({ id: schema.movies.id });

    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Seating E2E Cinema", address: "Rua Teste, 1", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });

    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala E2E", rows: 1, seatsPerRow: 3 })
      .returning({ id: schema.rooms.id });

    const insertedSeats = await db
      .insert(schema.seats)
      .values([
        { roomId, rowLabel: "A", seatNumber: 1 },
        { roomId, rowLabel: "A", seatNumber: 2 },
        { roomId, rowLabel: "A", seatNumber: 3 },
      ])
      .returning({ id: schema.seats.id });
    seatIds = insertedSeats.map((seat) => seat.id);

    [{ id: sessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId, startsAt: new Date(), priceCents: 2500 })
      .returning({ id: schema.sessions.id });
  });

  afterAll(async () => {
    await valkey.del(...seatIds.map((seatId) => `seat-hold:${sessionId}:${seatId}`));
    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, sessionId));
    await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    await db.delete(schema.seats).where(eq(schema.seats.roomId, roomId));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, cinemaId));
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await cleanupClient.end();
    valkey.disconnect();
    await app.close();
  });

  it("should reject requests without a valid token", async () => {
    // GIVEN no Authorization header

    // WHEN the client calls GET /sessions/:id/seats
    const response = await app.inject({ method: "GET", url: `/sessions/${sessionId}/seats` });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });

  it("should return 404 for a session that does not exist", async () => {
    // GIVEN an authenticated user

    // WHEN the client requests a session id that doesn't exist
    const response = await app.inject({
      method: "GET",
      url: "/sessions/00000000-0000-0000-0000-0000000000ff/seats",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 404
    expect(response.statusCode).toBe(404);
  });

  it("should return every seat as free when there are no bookings or holds", async () => {
    // GIVEN a session with 3 seats, none booked or held

    // WHEN the client requests the seat map
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/seats`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 200 with 3 free seats and the session's price
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.priceCents).toBe(2500);
    expect(body.room).toEqual({ rows: 1, seatsPerRow: 3 });
    expect(body.seats).toHaveLength(3);
    expect(body.seats.every((seat: { status: string }) => seat.status === "free")).toBe(true);
  });

  it("should mark a seat as booked once its booking is confirmed", async () => {
    // GIVEN a confirmed booking for the first seat
    const [{ id: bookingId }] = await db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "confirmed" })
      .returning({ id: schema.bookings.id });
    await db.insert(schema.bookingSeats).values({ bookingId, sessionId, seatId: seatIds[0] });

    // WHEN the client requests the seat map
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/seats`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN the booked seat shows as "booked", the others stay free
    const body = response.json();
    const seatStatuses = Object.fromEntries(
      body.seats.map((seat: { id: string; status: string }) => [seat.id, seat.status]),
    );
    expect(seatStatuses[seatIds[0]]).toBe("booked");
    expect(seatStatuses[seatIds[1]]).toBe("free");
  });

  it("should distinguish held_by_me from held_by_other based on the requesting user", async () => {
    // GIVEN seat 2 held by the requesting user and seat 3 held by someone else
    await valkey.set(`seat-hold:${sessionId}:${seatIds[1]}`, userId, "EX", 60);
    await valkey.set(`seat-hold:${sessionId}:${seatIds[2]}`, otherUserId, "EX", 60);

    // WHEN the client requests the seat map
    const response = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/seats`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it reflects the correct hold ownership per seat
    const body = response.json();
    const seatStatuses = Object.fromEntries(
      body.seats.map((seat: { id: string; status: string }) => [seat.id, seat.status]),
    );
    expect(seatStatuses[seatIds[1]]).toBe("held_by_me");
    expect(seatStatuses[seatIds[2]]).toBe("held_by_other");
  });
});
