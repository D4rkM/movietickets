import * as bcrypt from "bcrypt";
import { eq, inArray } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";

type Db = PostgresJsDatabase<typeof schema>;

export interface CinemaFixture {
  sessionIds: string[];
  roomId: string;
  /** Inserts `count` fresh seats in the fixture room and returns their ids. */
  addSeats: (count: number) => Promise<string[]>;
  cleanup: () => Promise<void>;
}

/**
 * One movie, one cinema, one room and `sessionCount` sessions in it, all
 * labelled so parallel suites never collide. Seats are created on demand per
 * test, so every scenario starts from free seats.
 */
export async function createCinemaFixture(db: Db, label: string, sessionCount = 1): Promise<CinemaFixture> {
  const [{ id: movieId }] = await db
    .insert(schema.movies)
    .values({ title: `${label} Movie`, durationMinutes: 90 })
    .returning({ id: schema.movies.id });
  const [{ id: cinemaId }] = await db
    .insert(schema.cinemas)
    .values({ name: `${label} Cinema`, address: "Rua Teste, 1", city: "Testópolis" })
    .returning({ id: schema.cinemas.id });
  const [{ id: roomId }] = await db
    .insert(schema.rooms)
    .values({ cinemaId, name: `Sala ${label}`, rows: 10, seatsPerRow: 20 })
    .returning({ id: schema.rooms.id });
  const sessions = await db
    .insert(schema.sessions)
    .values(Array.from({ length: sessionCount }, () => ({ movieId, roomId, startsAt: new Date(), priceCents: 3000 })))
    .returning({ id: schema.sessions.id });
  const sessionIds = sessions.map((session) => session.id);

  let nextSeatNumber = 1;
  const addSeats = async (count: number): Promise<string[]> => {
    const seats = await db
      .insert(schema.seats)
      .values(Array.from({ length: count }, () => ({ roomId, rowLabel: "A", seatNumber: nextSeatNumber++ })))
      .returning({ id: schema.seats.id });
    return seats.map((seat) => seat.id);
  };

  const cleanup = async (): Promise<void> => {
    await db.delete(schema.bookingSeats).where(inArray(schema.bookingSeats.sessionId, sessionIds));
    await db.delete(schema.bookings).where(inArray(schema.bookings.sessionId, sessionIds));
    await db.delete(schema.sessions).where(inArray(schema.sessions.id, sessionIds));
    await db.delete(schema.seats).where(eq(schema.seats.roomId, roomId));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, cinemaId));
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
  };

  return { sessionIds, roomId, addSeats, cleanup };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** A customer with a real bcrypt password, so it can go through POST /auth/login. */
export async function createUserWithPassword(db: Db, label: string): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const password = "password123";
  const [{ id }] = await db
    .insert(schema.users)
    .values({ name: label, email, passwordHash: await bcrypt.hash(password, 4) })
    .returning({ id: schema.users.id });
  return { id, email, password };
}

export async function deleteUsers(db: Db, users: TestUser[]): Promise<void> {
  if (users.length === 0) return;
  await db.delete(schema.users).where(inArray(schema.users.id, users.map((user) => user.id)));
}
