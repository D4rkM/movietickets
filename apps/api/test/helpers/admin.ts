import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { asc, eq, inArray, or } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { AdminModule } from "../../src/admin/admin.module";
import { AuthModule } from "../../src/auth/auth.module";
import { CatalogModule } from "../../src/catalog/catalog.module";
import { DrizzleModule } from "../../src/db/drizzle.module";
import * as schema from "../../src/db/schema";
import { SeatingModule } from "../../src/seating/seating.module";
import { VALKEY, ValkeyModule } from "../../src/valkey/valkey.module";
import { buildFastifyApp } from "./build-app";
import { createUserWithPassword, TestUser } from "./cinema-fixture";
import { clearSessionHolds, holdSeatAs, loginWith } from "./guest-flow";

type Db = PostgresJsDatabase<typeof schema>;
type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type Payload = Record<string, unknown>;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Everything a suite created, so cleanup removes exactly that (suites share the database). */
interface CreatedData {
  users: TestUser[];
  movieIds: string[];
  cinemaIds: string[];
  roomIds: string[];
}

export interface AdminTestContext {
  app: NestFastifyApplication;
  db: Db;
  valkey: Redis;
  jwtService: JwtService;
  /** Access token of a freshly created `role: "admin"` user, obtained through POST /auth/login. */
  adminToken: string;
  /** Access token of a freshly created `role: "customer"` user, obtained through POST /auth/login. */
  customerToken: string;
  customer: TestUser;
  created: CreatedData;
  /** Short unique label, so names created by parallel suites never collide. */
  label: string;
  close: () => Promise<void>;
}

/**
 * Boots auth + seating + catalog + admin against the real Postgres/Valkey and
 * logs in one admin and one customer through the real login route.
 */
export async function startAdminApp(label: string): Promise<AdminTestContext> {
  process.env.JWT_SECRET ??= "test-secret";

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      DrizzleModule,
      ValkeyModule,
      AuthModule,
      SeatingModule,
      CatalogModule,
      AdminModule,
    ],
  }).compile();

  const sqlClient = postgres(process.env.DATABASE_URL!);
  const db = drizzle(sqlClient, { schema });

  const app = await buildFastifyApp(moduleRef);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const uniqueLabel = `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const created: CreatedData = { users: [], movieIds: [], cinemaIds: [], roomIds: [] };

  const admin = await createUserWithPassword(db, `${label}-admin`);
  await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.id));
  const customer = await createUserWithPassword(db, `${label}-customer`);
  created.users.push(admin, customer);

  const valkey = moduleRef.get<Redis>(VALKEY);
  const ctx: AdminTestContext = {
    app,
    db,
    valkey,
    jwtService: moduleRef.get(JwtService),
    adminToken: await loginForToken(app, admin),
    customerToken: await loginForToken(app, customer),
    customer,
    created,
    label: uniqueLabel,
    close: async () => {
      await cleanupCreatedData(db, valkey, created);
      await sqlClient.end();
      await app.close();
    },
  };
  return ctx;
}

async function loginForToken(app: NestFastifyApplication, user: TestUser): Promise<string> {
  const response = await loginWith(app, { email: user.email, password: user.password });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json().accessToken;
}

async function cleanupCreatedData(db: Db, valkey: Redis, created: CreatedData): Promise<void> {
  const cinemaRooms =
    created.cinemaIds.length > 0
      ? await db.select({ id: schema.rooms.id }).from(schema.rooms).where(inArray(schema.rooms.cinemaId, created.cinemaIds))
      : [];
  const roomIds = [...new Set([...created.roomIds, ...cinemaRooms.map((room) => room.id)])];

  const sessionConditions = [
    roomIds.length > 0 ? inArray(schema.sessions.roomId, roomIds) : undefined,
    created.movieIds.length > 0 ? inArray(schema.sessions.movieId, created.movieIds) : undefined,
  ].filter((condition) => condition !== undefined);
  const sessions =
    sessionConditions.length > 0
      ? await db.select({ id: schema.sessions.id }).from(schema.sessions).where(or(...sessionConditions))
      : [];
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length > 0) {
    await clearSessionHolds(valkey, sessionIds);
    await db.delete(schema.bookingSeats).where(inArray(schema.bookingSeats.sessionId, sessionIds));
    await db.delete(schema.bookings).where(inArray(schema.bookings.sessionId, sessionIds));
    await db.delete(schema.sessions).where(inArray(schema.sessions.id, sessionIds));
  }
  if (roomIds.length > 0) {
    await db.delete(schema.seats).where(inArray(schema.seats.roomId, roomIds));
    await db.delete(schema.rooms).where(inArray(schema.rooms.id, roomIds));
  }
  if (created.cinemaIds.length > 0) {
    await db.delete(schema.cinemas).where(inArray(schema.cinemas.id, created.cinemaIds));
  }
  if (created.movieIds.length > 0) {
    await db.delete(schema.movies).where(inArray(schema.movies.id, created.movieIds));
  }
  if (created.users.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, created.users.map((user) => user.id)));
  }
}

// ---------------------------------------------------------------------------
// Raw calls
// ---------------------------------------------------------------------------

/** Calls any route with the given bearer token (or none, when `token` is undefined). */
export function callWithToken(
  ctx: AdminTestContext,
  token: string | undefined,
  method: HttpMethod,
  url: string,
  payload?: Payload,
) {
  return ctx.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

export function callAsAdmin(ctx: AdminTestContext, method: HttpMethod, url: string, payload?: Payload) {
  return callWithToken(ctx, ctx.adminToken, method, url, payload);
}

export function callAsCustomer(ctx: AdminTestContext, method: HttpMethod, url: string, payload?: Payload) {
  return callWithToken(ctx, ctx.customerToken, method, url, payload);
}

/** A correctly signed admin token that expired a minute ago. */
export function expiredAdminToken(ctx: AdminTestContext): string {
  return ctx.jwtService.sign(
    { kind: "user", sub: ctx.created.users[0].id, email: ctx.created.users[0].email, role: "admin" },
    { expiresIn: -60 },
  );
}

type InjectResponse = Awaited<ReturnType<typeof callAsAdmin>>;

function expectStatus(response: InjectResponse, status: number, action: string): void {
  if (response.statusCode !== status) {
    throw new Error(`${action} answered ${response.statusCode} instead of ${status}: ${response.body}`);
  }
}

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

export interface AdminMovieBody {
  id: string;
  title: string;
  synopsis: string | null;
  durationMinutes: number;
  posterUrl: string | null;
  rating: string | null;
}

export function validMoviePayload(ctx: AdminTestContext, overrides: Payload = {}): Payload {
  return { title: `${ctx.label} Filme`, durationMinutes: 120, rating: "14", ...overrides };
}

/** POST /admin/movies as admin; a 201 is tracked for cleanup. */
export async function postMovieAsAdmin(ctx: AdminTestContext, payload: Payload) {
  const response = await callAsAdmin(ctx, "POST", "/admin/movies", payload);
  if (response.statusCode === 201) ctx.created.movieIds.push(response.json().id);
  return response;
}

export async function createMovieAsAdmin(ctx: AdminTestContext, overrides: Payload = {}): Promise<AdminMovieBody> {
  const response = await postMovieAsAdmin(ctx, validMoviePayload(ctx, overrides));
  expectStatus(response, 201, "Movie creation");
  return response.json();
}

export function updateMovieAsAdmin(ctx: AdminTestContext, movieId: string, payload: Payload) {
  return callAsAdmin(ctx, "PATCH", `/admin/movies/${movieId}`, payload);
}

export function deleteMovieAsAdmin(ctx: AdminTestContext, movieId: string) {
  return callAsAdmin(ctx, "DELETE", `/admin/movies/${movieId}`);
}

export async function findMovieInDb(ctx: AdminTestContext, movieId: string): Promise<schema.Movie | undefined> {
  return ctx.db.query.movies.findFirst({ where: eq(schema.movies.id, movieId) });
}

export async function countMoviesTitled(ctx: AdminTestContext, title: string): Promise<number> {
  const rows = await ctx.db.select({ id: schema.movies.id }).from(schema.movies).where(eq(schema.movies.title, title));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Cinemas
// ---------------------------------------------------------------------------

export interface AdminCinemaBody {
  id: string;
  name: string;
  address: string;
  city: string;
}

/** POST /admin/cinemas as admin; a 201 is tracked for cleanup. */
export async function postCinemaAsAdmin(ctx: AdminTestContext, payload: Payload) {
  const response = await callAsAdmin(ctx, "POST", "/admin/cinemas", payload);
  if (response.statusCode === 201) ctx.created.cinemaIds.push(response.json().id);
  return response;
}

export async function createCinemaAsAdmin(ctx: AdminTestContext, overrides: Payload = {}): Promise<AdminCinemaBody> {
  const response = await postCinemaAsAdmin(ctx, {
    name: `${ctx.label} Cinema ${ctx.created.cinemaIds.length + 1}`,
    address: "Rua Admin, 10",
    city: "Testópolis",
    ...overrides,
  });
  expectStatus(response, 201, "Cinema creation");
  return response.json();
}

export function updateCinemaAsAdmin(ctx: AdminTestContext, cinemaId: string, payload: Payload) {
  return callAsAdmin(ctx, "PATCH", `/admin/cinemas/${cinemaId}`, payload);
}

export async function listCinemasAsAdmin(ctx: AdminTestContext): Promise<AdminCinemaBody[]> {
  const response = await callAsAdmin(ctx, "GET", "/admin/cinemas");
  expectStatus(response, 200, "Cinema listing");
  return response.json();
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface AdminRoomBody {
  id: string;
  name: string;
  rows: number;
  seatsPerRow: number;
  cinemaId: string;
  cinemaName: string;
}

/** POST /admin/rooms as admin; a 201 is tracked for cleanup. */
export async function postRoomAsAdmin(ctx: AdminTestContext, payload: Payload) {
  const response = await callAsAdmin(ctx, "POST", "/admin/rooms", payload);
  if (response.statusCode === 201) ctx.created.roomIds.push(response.json().id);
  return response;
}

/** Creates a room (in a new cinema unless `cinemaId` is given). Defaults to a 3 × 4 room. */
export async function createRoomAsAdmin(ctx: AdminTestContext, overrides: Payload = {}): Promise<AdminRoomBody> {
  const cinemaId = overrides.cinemaId ?? (await createCinemaAsAdmin(ctx)).id;
  const response = await postRoomAsAdmin(ctx, {
    name: `Sala ${ctx.created.roomIds.length + 1}`,
    rows: 3,
    seatsPerRow: 4,
    ...overrides,
    cinemaId,
  });
  expectStatus(response, 201, "Room creation");
  return response.json();
}

export function updateRoomAsAdmin(ctx: AdminTestContext, roomId: string, payload: Payload) {
  return callAsAdmin(ctx, "PATCH", `/admin/rooms/${roomId}`, payload);
}

export function deleteRoomAsAdmin(ctx: AdminTestContext, roomId: string) {
  return callAsAdmin(ctx, "DELETE", `/admin/rooms/${roomId}`);
}

/** Seat labels of a room straight from the database, ordered by row then number (e.g. ["A1", "A2", ...]). */
export async function seatLabelsOfRoom(ctx: AdminTestContext, roomId: string): Promise<string[]> {
  const seats = await ctx.db
    .select({ rowLabel: schema.seats.rowLabel, seatNumber: schema.seats.seatNumber })
    .from(schema.seats)
    .where(eq(schema.seats.roomId, roomId))
    .orderBy(asc(schema.seats.rowLabel), asc(schema.seats.seatNumber));
  return seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`);
}

export async function seatIdsOfRoom(ctx: AdminTestContext, roomId: string): Promise<string[]> {
  const seats = await ctx.db
    .select({ id: schema.seats.id })
    .from(schema.seats)
    .where(eq(schema.seats.roomId, roomId))
    .orderBy(asc(schema.seats.rowLabel), asc(schema.seats.seatNumber));
  return seats.map((seat) => seat.id);
}

export async function findRoomInDb(ctx: AdminTestContext, roomId: string): Promise<schema.Room | undefined> {
  return ctx.db.query.rooms.findFirst({ where: eq(schema.rooms.id, roomId) });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface AdminSessionBody {
  id: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  movie: { id: string; title: string; durationMinutes: number };
  room: { id: string; name: string };
  cinema: { id: string; name: string };
}

/** Midnight UTC `days` days from today, plus `hour`:`minute` — a stable, clearly future instant. */
export function daysFromNow(days: number, hour = 19, minute = 0): Date {
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(midnight + days * MS_PER_DAY + (hour * 60 + minute) * MS_PER_MINUTE);
}

export function plusMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}

export function postSessionAsAdmin(ctx: AdminTestContext, payload: Payload) {
  return callAsAdmin(ctx, "POST", "/admin/sessions", payload);
}

export async function createSessionAsAdmin(
  ctx: AdminTestContext,
  session: { movieId: string; roomId: string; startsAt: Date; priceCents?: number },
): Promise<AdminSessionBody> {
  const response = await postSessionAsAdmin(ctx, {
    movieId: session.movieId,
    roomId: session.roomId,
    startsAt: session.startsAt.toISOString(),
    priceCents: session.priceCents ?? 3000,
  });
  expectStatus(response, 201, "Session creation");
  return response.json();
}

export function updateSessionAsAdmin(ctx: AdminTestContext, sessionId: string, payload: Payload) {
  return callAsAdmin(ctx, "PATCH", `/admin/sessions/${sessionId}`, payload);
}

export function deleteSessionAsAdmin(ctx: AdminTestContext, sessionId: string) {
  return callAsAdmin(ctx, "DELETE", `/admin/sessions/${sessionId}`);
}

/**
 * Inserts a session straight into the database, bypassing the API — the only
 * way to get a session in the past (the API only accepts future `startsAt`).
 */
export async function insertSessionDirectly(
  ctx: AdminTestContext,
  session: { movieId: string; roomId: string; startsAt: Date; priceCents?: number },
): Promise<string> {
  const [row] = await ctx.db
    .insert(schema.sessions)
    .values({ ...session, priceCents: session.priceCents ?? 3000 })
    .returning({ id: schema.sessions.id });
  return row.id;
}

/**
 * Opens several pooled Postgres connections up front by firing parallel reads.
 * Without it, the second of two "simultaneous" requests waits for a brand-new
 * connection handshake and only starts after the first one has committed, so
 * the race the test is about never happens.
 */
export async function warmUpConnectionPool(ctx: AdminTestContext, connections = 6): Promise<void> {
  await Promise.all(Array.from({ length: connections }, () => callAsAdmin(ctx, "GET", "/admin/sessions")));
}

export async function findSessionInDb(ctx: AdminTestContext, sessionId: string): Promise<schema.Session | undefined> {
  return ctx.db.query.sessions.findFirst({ where: eq(schema.sessions.id, sessionId) });
}

export async function countSessionsInRoom(ctx: AdminTestContext, roomId: string): Promise<number> {
  const rows = await ctx.db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.roomId, roomId));
  return rows.length;
}

/** A room with one movie ready to schedule sessions in it. */
export async function createRoomWithMovie(
  ctx: AdminTestContext,
  movieOverrides: Payload = {},
): Promise<{ movie: AdminMovieBody; room: AdminRoomBody }> {
  const movie = await createMovieAsAdmin(ctx, movieOverrides);
  const room = await createRoomAsAdmin(ctx);
  return { movie, room };
}

/** A future session (in a new room, for a new 120-min movie) ready to be edited or deleted. */
export async function createScheduledSession(
  ctx: AdminTestContext,
  startsAt: Date = daysFromNow(10),
): Promise<{ movie: AdminMovieBody; room: AdminRoomBody; session: AdminSessionBody }> {
  const { movie, room } = await createRoomWithMovie(ctx);
  const session = await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt });
  return { movie, room, session };
}

// ---------------------------------------------------------------------------
// Purchase activity (bookings and holds)
// ---------------------------------------------------------------------------

/**
 * Inserts a booking for the suite's customer on the first seat of the room,
 * with the seat priced at `priceCents` — the state the booking flow would leave
 * behind. Inserted directly so each status can be set up without a payment.
 */
export async function insertBooking(
  ctx: AdminTestContext,
  sessionId: string,
  roomId: string,
  status: "pending" | "confirmed" | "cancelled" | "expired",
  priceCents = 3000,
  expiresAt?: Date,
): Promise<{ bookingId: string; seatId: string }> {
  const [seatId] = await seatIdsOfRoom(ctx, roomId);
  const [booking] = await ctx.db
    .insert(schema.bookings)
    .values({ userId: ctx.customer.id, sessionId, status, ...(expiresAt ? { expiresAt } : {}) })
    .returning({ id: schema.bookings.id });
  await ctx.db.insert(schema.bookingSeats).values({ bookingId: booking.id, sessionId, seatId, priceCents });
  return { bookingId: booking.id, seatId };
}

/**
 * A checkout abandoned before paying: still `pending` (the sweeper hasn't
 * flipped it to `expired` yet), past its deadline, with no payment row.
 */
export function insertAbandonedPendingBooking(ctx: AdminTestContext, sessionId: string, roomId: string) {
  return insertBooking(ctx, sessionId, roomId, "pending", 3000, plusMinutes(new Date(), -1));
}

export async function bookedSeatPrices(ctx: AdminTestContext, bookingId: string): Promise<number[]> {
  const rows = await ctx.db
    .select({ priceCents: schema.bookingSeats.priceCents })
    .from(schema.bookingSeats)
    .where(eq(schema.bookingSeats.bookingId, bookingId));
  return rows.map((row) => row.priceCents);
}

/** The suite's customer holds the room's first seat through the real hold route (active Valkey hold). */
export async function holdFirstSeatAsCustomer(ctx: AdminTestContext, sessionId: string, roomId: string): Promise<void> {
  const [seatId] = await seatIdsOfRoom(ctx, roomId);
  const response = await holdSeatAs(ctx.app, ctx.customerToken, sessionId, seatId);
  expectStatus(response, 200, "Seat hold");
}

export async function countBookingsOfSession(ctx: AdminTestContext, sessionId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(eq(schema.bookings.sessionId, sessionId));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Public catalog and seat map
// ---------------------------------------------------------------------------

export interface CatalogSessionBody {
  id: string;
  startsAt: string;
  priceCents: number;
  room: { id: string; name: string };
}

/** The movie as `GET /movies` (public catalog) shows it right now, or undefined if it's not listed. */
export async function catalogMovie(
  ctx: AdminTestContext,
  movieId: string,
): Promise<{ id: string; title: string; sessions: CatalogSessionBody[] } | undefined> {
  const response = await ctx.app.inject({ method: "GET", url: "/movies" });
  expectStatus(response, 200, "Catalog listing");
  return response.json().find((movie: { id: string }) => movie.id === movieId);
}

/** Every session id the public catalog lists right now. */
export async function catalogSessionIds(ctx: AdminTestContext): Promise<string[]> {
  const response = await ctx.app.inject({ method: "GET", url: "/movies" });
  expectStatus(response, 200, "Catalog listing");
  return response.json().flatMap((movie: { sessions: { id: string }[] }) => movie.sessions.map((session) => session.id));
}

/** Seat statuses of a session as the seat-map route returns them to the admin. */
export async function seatMapStatuses(ctx: AdminTestContext, sessionId: string): Promise<string[]> {
  const response = await callAsAdmin(ctx, "GET", `/sessions/${sessionId}/seats`);
  expectStatus(response, 200, "Seat map");
  return response.json().seats.map((seat: { status: string }) => seat.status);
}
