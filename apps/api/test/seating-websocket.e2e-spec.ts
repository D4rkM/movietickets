import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { io, Socket as ClientSocket } from "socket.io-client";
import { AuthModule } from "../src/auth/auth.module";
import { BookingModule } from "../src/booking/booking.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { SeatingModule } from "../src/seating/seating.module";
import { ValkeyModule } from "../src/valkey/valkey.module";
import { buildFastifyApp } from "./helpers/build-app";

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe("Seating WebSocket gateway (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let baseUrl: string;
  let accessToken: string;
  let otherAccessToken: string;

  let userId: string;
  let otherUserId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DrizzleModule,
        ValkeyModule,
        AuthModule,
        SeatingModule,
        BookingModule,
      ],
    }).compile();

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const jwtService = moduleRef.get(JwtService);

    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ name: "WS E2E User", email: "ws-e2e@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });
    [{ id: otherUserId }] = await db
      .insert(schema.users)
      .values({ name: "WS E2E User 2", email: "ws-e2e-2@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });

    accessToken = jwtService.sign({ sub: userId, email: "ws-e2e@test.com", role: "customer" });
    otherAccessToken = jwtService.sign({ sub: otherUserId, email: "ws-e2e-2@test.com", role: "customer" });

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "WS E2E Movie", durationMinutes: 90 })
      .returning({ id: schema.movies.id });
    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "WS E2E Cinema", address: "Rua Teste, 1", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });
    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala WS E2E", rows: 1, seatsPerRow: 4 })
      .returning({ id: schema.rooms.id });
    [{ id: sessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId, startsAt: new Date(), priceCents: 2000 })
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
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    await cleanupClient.end();
    await app.close();
  });

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/seating`, {
        auth: { token },
        transports: ["websocket"],
        reconnection: false,
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
  }

  it("should disconnect a client that connects with no auth token", async () => {
    // GIVEN a client connecting with no auth token
    const socket = io(`${baseUrl}/seating`, { transports: ["websocket"], reconnection: false });

    // WHEN it connects — the socket.io handshake always completes at the
    // transport level first, so "connect" still fires; the gateway's
    // handleConnection then rejects it for having no token and disconnects
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for disconnect")), 2000);
      socket.once("disconnect", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // THEN the server disconnects it right after
    await expect(disconnected).resolves.toBeUndefined();
    socket.close();
  });

  it("should notify a second client in the same session room when a seat is held", async () => {
    // GIVEN a free seat, and two clients (two browser tabs) both viewing the same session
    const [seat] = await db.insert(schema.seats).values({ roomId, rowLabel: "A", seatNumber: 1 }).returning();
    const viewerSocket = await connect(otherAccessToken);
    const holderSocket = await connect(accessToken);
    viewerSocket.emit("join", sessionId);
    holderSocket.emit("join", sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const nextUpdate = waitForEvent<{ seatId: string; status: string; heldByUserId?: string }>(
      viewerSocket,
      "seat:update",
    );

    // WHEN the holder holds the seat via the REST endpoint
    const holdResponse = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seat.id}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(holdResponse.statusCode).toBe(200);

    // THEN the other client (the second tab) receives the broadcast in real time
    const update = await nextUpdate;
    expect(update).toEqual({ seatId: seat.id, status: "held", heldByUserId: userId });

    viewerSocket.disconnect();
    holderSocket.disconnect();
  });

  it("should not notify a client that already left the session room", async () => {
    // GIVEN a client that joined and then left the session room
    const [seat] = await db.insert(schema.seats).values({ roomId, rowLabel: "B", seatNumber: 1 }).returning();
    const leftSocket = await connect(otherAccessToken);
    leftSocket.emit("join", sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    leftSocket.emit("leave", sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    let receivedUpdate = false;
    leftSocket.once("seat:update", () => {
      receivedUpdate = true;
    });

    // WHEN a seat in that session is held
    const holdResponse = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seat.id}/hold`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(holdResponse.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // THEN the client that left never receives the broadcast
    expect(receivedUpdate).toBe(false);

    leftSocket.disconnect();
  });

  it("should notify the room with a 'booked' event once a booking is confirmed", async () => {
    // GIVEN a booked-and-confirmed seat, and a client watching the session
    const [seat] = await db.insert(schema.seats).values({ roomId, rowLabel: "C", seatNumber: 1 }).returning();
    const viewerSocket = await connect(otherAccessToken);
    viewerSocket.emit("join", sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const bookResponse = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/seats/${seat.id}/book`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ticketType: "full" },
    });
    const bookingId = bookResponse.json().bookingId;

    const nextUpdate = waitForEvent<{ seatId: string; status: string }>(viewerSocket, "seat:update");

    // WHEN the booking is confirmed
    const confirmResponse = await app.inject({
      method: "POST",
      url: `/bookings/${bookingId}/confirm`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(confirmResponse.statusCode).toBe(200);

    // THEN the room receives a "booked" broadcast for that seat
    const update = await nextUpdate;
    expect(update).toEqual({ seatId: seat.id, status: "booked" });

    viewerSocket.disconnect();
  });
});
