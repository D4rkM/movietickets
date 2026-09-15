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
import { SeatingModule } from "../src/seating/seating.module";
import { ValkeyModule } from "../src/valkey/valkey.module";
import { buildFastifyApp } from "./helpers/build-app";

describe("Booking (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let accessToken: string;
  let jwtService: JwtService;

  let userId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;
  let seatId: string;
  let otherSeatId: string;
  let bookingId: string;

  const otherUserId = "00000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DrizzleModule,
        ValkeyModule,
        AuthModule,
        BookingModule,
        SeatingModule,
      ],
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

    jwtService = moduleRef.get(JwtService);
    accessToken = jwtService.sign({ sub: userId, email: "booking-e2e@test.com", role: "customer" });

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
    [{ id: otherSeatId }] = await db
      .insert(schema.seats)
      .values({ roomId, rowLabel: "A", seatNumber: 2 })
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
      payload: { ticketType: "full" },
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
      payload: { ticketType: "full" },
    });

    // THEN it returns 404
    expect(response.statusCode).toBe(404);
  });

  it("should return 400 for an unknown ticket type", async () => {
    // GIVEN an authenticated user

    // WHEN the client books with an invalid ticketType
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "vip" },
    });

    // THEN it returns 400
    expect(response.statusCode).toBe(400);
  });

  it("should return 400 for a half ticket with no document", async () => {
    // GIVEN an authenticated user

    // WHEN the client books a half ticket without a document
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "half" },
    });

    // THEN it returns 400
    expect(response.statusCode).toBe(400);
  });

  it("should create a pending booking with the full price and link the chosen seat", async () => {
    // GIVEN an authenticated user and a valid session + seat

    // WHEN the client books a full-price ticket
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "full" },
    });

    // THEN it returns 201 with the booking data, and the rows exist in Postgres
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({
      bookingId: expect.any(String),
      seatId,
      status: "pending",
      ticketType: "full",
      priceCents: 3000,
    });

    const booking = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, body.bookingId) });
    expect(booking).toMatchObject({ userId, sessionId, status: "pending" });

    const bookingSeat = await db.query.bookingSeats.findFirst({
      where: eq(schema.bookingSeats.bookingId, body.bookingId),
    });
    expect(bookingSeat).toMatchObject({
      sessionId,
      seatId,
      ticketType: "full",
      halfPriceDocument: null,
      priceCents: 3000,
    });

    bookingId = body.bookingId;
  });

  it("should charge half price and store the document for a half ticket", async () => {
    // GIVEN an authenticated user and a valid session + seat

    // WHEN the client books a half-price ticket with a document
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${otherSeatId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "half", halfPriceDocument: "1234567890" },
    });

    // THEN it returns 201 with half the session price, and the document is stored
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ ticketType: "half", priceCents: 1500 });

    const bookingSeat = await db.query.bookingSeats.findFirst({
      where: eq(schema.bookingSeats.bookingId, body.bookingId),
    });
    expect(bookingSeat).toMatchObject({
      ticketType: "half",
      halfPriceDocument: "1234567890",
      priceCents: 1500,
    });
  });

  it("should create one booking covering every seat in the request", async () => {
    // GIVEN an authenticated user and two free seats
    const [seatA, seatB] = await db
      .insert(schema.seats)
      .values([
        { roomId, rowLabel: "B", seatNumber: 1 },
        { roomId, rowLabel: "B", seatNumber: 2 },
      ])
      .returning();

    // WHEN the client books both seats in a single request
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        seats: [
          { seatId: seatA.id, ticketType: "full" },
          { seatId: seatB.id, ticketType: "half", halfPriceDocument: "1234567890" },
        ],
      },
    });

    // THEN it returns 201 with both seats sharing the same bookingId
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].bookingId).toBe(body[1].bookingId);

    const bookingSeats = await db.query.bookingSeats.findMany({
      where: eq(schema.bookingSeats.bookingId, body[0].bookingId),
    });
    expect(bookingSeats).toHaveLength(2);
  });

  it("should book nothing when one of the requested seats is already taken", async () => {
    // GIVEN a free seat and a seat that's already booked for this session
    const [freeSeat, takenSeat] = await db
      .insert(schema.seats)
      .values([
        { roomId, rowLabel: "C", seatNumber: 1 },
        { roomId, rowLabel: "C", seatNumber: 2 },
      ])
      .returning();
    await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${takenSeat.id}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "full" },
    });

    // WHEN the client tries to book the free seat together with the taken one
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        seats: [
          { seatId: freeSeat.id, ticketType: "full" },
          { seatId: takenSeat.id, ticketType: "full" },
        ],
      },
    });

    // THEN it returns 409, and the free seat was NOT booked either — the whole request rolled back
    expect(response.statusCode).toBe(409);
    const freeSeatBooking = await db.query.bookingSeats.findFirst({
      where: eq(schema.bookingSeats.seatId, freeSeat.id),
    });
    expect(freeSeatBooking).toBeUndefined();
  });

  it("should reject confirming a booking without a valid token", async () => {
    // GIVEN no Authorization header

    // WHEN the client calls POST /bookings/:id/confirm
    const response = await app.inject({ method: "POST", url: `/bookings/${bookingId}/confirm` });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });

  it("should return 404 when confirming a booking that belongs to someone else", async () => {
    // GIVEN a token for a different user than the one who created the booking
    const otherToken = jwtService.sign({
      sub: otherUserId,
      email: "someone-else@test.com",
      role: "customer",
    });

    // WHEN that user tries to confirm the booking
    const response = await app.inject({
      method: "POST",
      url: `/bookings/${bookingId}/confirm`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    // THEN it returns 404
    expect(response.statusCode).toBe(404);
  });

  it("should confirm a pending booking and make its seat show as booked on the seat map", async () => {
    // GIVEN a pending booking for the authenticated user

    // WHEN the client confirms the mocked payment
    const confirmResponse = await app.inject({
      method: "POST",
      url: `/bookings/${bookingId}/confirm`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 200 with status "confirmed", and the seat map reflects it as booked
    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json()).toEqual({ bookingId, status: "confirmed" });

    const seatMapResponse = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/seats`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const seat = seatMapResponse.json().seats.find((s: { id: string }) => s.id === seatId);
    expect(seat.status).toBe("booked");
  });

  it("should reject confirming a booking that is already confirmed", async () => {
    // GIVEN a booking that was already confirmed

    // WHEN the client tries to confirm it again
    const response = await app.inject({
      method: "POST",
      url: `/bookings/${bookingId}/confirm`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // THEN it returns 409
    expect(response.statusCode).toBe(409);
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
      .values({ roomId, rowLabel: "A", seatNumber: 3 })
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
      seats: [{ rowLabel: "A", seatNumber: 3 }],
    });

    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, confirmedBooking.id));
    await db.delete(schema.bookings).where(eq(schema.bookings.id, confirmedBooking.id));
    await db.delete(schema.bookings).where(eq(schema.bookings.id, pendingBooking.id));
    await db.delete(schema.seats).where(eq(schema.seats.id, otherSeat.id));
  });
});
