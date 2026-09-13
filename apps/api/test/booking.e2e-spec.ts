import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AuthModule } from "../src/auth/auth.module";
import { BookingModule } from "../src/booking/booking.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { buildFastifyApp } from "./helpers/build-app";

describe("Booking (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let accessToken: string;

  let userId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;
  let seatId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, AuthModule, BookingModule],
    }).compile();

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ name: "Booking E2E User", email: "booking-e2e@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });

    accessToken = moduleRef
      .get(JwtService)
      .sign({ sub: userId, email: "booking-e2e@test.com", role: "customer" });

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "Booking E2E Movie", durationMinutes: 90 })
      .returning({ id: schema.movies.id });

    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Booking E2E Cinema", address: "Rua Teste, 1", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });

    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala Booking E2E", rows: 1, seatsPerRow: 1 })
      .returning({ id: schema.rooms.id });

    [{ id: seatId }] = await db
      .insert(schema.seats)
      .values({ roomId, rowLabel: "A", seatNumber: 1 })
      .returning({ id: schema.seats.id });

    [{ id: sessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId, startsAt: new Date(), priceCents: 3000 })
      .returning({ id: schema.sessions.id });
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
    await cleanupClient.end();
    await app.close();
  });

  it("should reject requests without a valid token", async () => {
    // GIVEN no Authorization header

    // WHEN the client calls POST /sessions/:id/seats/:seatId/book
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/book`,
    });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });

  it("should return 404 for a session that does not exist", async () => {
    // GIVEN an authenticated user

    // WHEN the client books a seat for a session id that doesn't exist
    const response = await app.inject({
      method: "POST",
      url: `/sessions/00000000-0000-0000-0000-0000000000ff/seats/${seatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 404
    expect(response.statusCode).toBe(404);
  });

  it("should create a pending booking and link the chosen seat", async () => {
    // GIVEN an authenticated user and a valid session + seat

    // WHEN the client books the seat
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 201 with the booking data, and the rows exist in Postgres
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({ bookingId: expect.any(String), seatId, status: "pending" });

    const booking = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, body.bookingId) });
    expect(booking).toMatchObject({ userId, sessionId, status: "pending" });

    const bookingSeat = await db.query.bookingSeats.findFirst({
      where: eq(schema.bookingSeats.bookingId, body.bookingId),
    });
    expect(bookingSeat).toMatchObject({ sessionId, seatId });
  });

  it("should reject GET /bookings/mine without a valid token", async () => {
    // GIVEN no Authorization header

    // WHEN the client calls GET /bookings/mine
    const response = await app.inject({ method: "GET", url: "/bookings/mine" });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });

  it("should list only the user's confirmed bookings, with session and seat details", async () => {
    // GIVEN a confirmed booking and a pending booking for the same user
    const [otherSeat] = await db
      .insert(schema.seats)
      .values({ roomId, rowLabel: "A", seatNumber: 2 })
      .returning();
    const [confirmedBooking] = await db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "confirmed" })
      .returning();
    await db.insert(schema.bookingSeats).values({
      bookingId: confirmedBooking.id,
      sessionId,
      seatId: otherSeat.id,
    });
    const [pendingBooking] = await db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "pending" })
      .returning();

    // WHEN the client requests their booking history
    const response = await app.inject({
      method: "GET",
      url: "/bookings/mine",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns only the confirmed booking, with movie/session/seat details
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const bookingIds = body.map((booking: { bookingId: string }) => booking.bookingId);
    expect(bookingIds).toContain(confirmedBooking.id);
    expect(bookingIds).not.toContain(pendingBooking.id);

    const entry = body.find((booking: { bookingId: string }) => booking.bookingId === confirmedBooking.id);
    expect(entry).toMatchObject({
      status: "confirmed",
      session: { movie: { title: "Booking E2E Movie" } },
      seats: [{ rowLabel: "A", seatNumber: 2 }],
    });

    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, confirmedBooking.id));
    await db.delete(schema.bookings).where(eq(schema.bookings.id, confirmedBooking.id));
    await db.delete(schema.bookings).where(eq(schema.bookings.id, pendingBooking.id));
    await db.delete(schema.seats).where(eq(schema.seats.id, otherSeat.id));
  });
});
