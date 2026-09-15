import "dotenv/config";
import * as bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const SALT_ROUNDS = 10;
const DEV_PASSWORD = "password123";
const SAMPLE_MOVIE_TITLE = "Vingadores Ultimato";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL não definida");
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema });

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, SALT_ROUNDS);

  await db
    .insert(schema.users)
    .values([
      { name: "Admin", email: "admin@movietickets.dev", passwordHash, role: "admin" },
      { name: "Cliente", email: "cliente@movietickets.dev", passwordHash, role: "customer" },
    ])
    .onConflictDoNothing({ target: schema.users.email });

  const sessionId = await seedSampleSession(db);

  console.log(`Seed ok. Usuários de teste (senha: "${DEV_PASSWORD}"):`);
  console.log("  admin@movietickets.dev (role: admin)");
  console.log("  cliente@movietickets.dev (role: customer)");
  console.log(`Sessão de teste pra GET /sessions/:id/seats: ${sessionId}`);

  await client.end();
}

/** Creates (or reuses, if already seeded) a movie/cinema/room/seats/session fixture for manual testing. */
async function seedSampleSession(db: PostgresJsDatabase<typeof schema>): Promise<string> {
  const existingMovie = await db.query.movies.findFirst({
    where: eq(schema.movies.title, SAMPLE_MOVIE_TITLE),
  });
  if (existingMovie) {
    const existingSession = await db.query.sessions.findFirst({
      where: eq(schema.sessions.movieId, existingMovie.id),
    });
    if (existingSession) {
      return existingSession.id;
    }
  }

  const [movie] =
    existingMovie != null
      ? [existingMovie]
      : await db
          .insert(schema.movies)
          .values({ title: SAMPLE_MOVIE_TITLE, durationMinutes: 120 })
          .returning();

  const [cinema] = await db
    .insert(schema.cinemas)
    .values({ name: "Cinemarcus", address: "Rua de Teste, 123", city: "Testópolis" })
    .returning();

  const [room] = await db
    .insert(schema.rooms)
    .values({ cinemaId: cinema.id, name: "Sala 1", rows: 13, seatsPerRow: 28 })
    .returning();

  // The back row has no aisle (seats run edge to edge), so it needs a few extra
  // seats to visually span the same width as the front rows' two aisles.
  const BACK_ROW_SEAT_COUNT = 32;
  // The first rows (closest to the screen) have no side seats, only the middle
  // block — must match the middle-block size (seatsPerRow - 2 side blocks) used
  // by the rows that do have side seats, so seats line up across rows.
  const FRONT_ROWS_WITHOUT_SIDE_SEATS = 3;
  const FRONT_ROW_SEAT_COUNT = 20;

  const insertedSeats = await db.insert(schema.seats).values(
    Array.from({ length: room.rows }, (_, rowIndex) => {
      const isBackRow = rowIndex === room.rows - 1;
      const isFrontRow = rowIndex < FRONT_ROWS_WITHOUT_SIDE_SEATS;
      const seatCount = isBackRow
        ? BACK_ROW_SEAT_COUNT
        : isFrontRow
          ? FRONT_ROW_SEAT_COUNT
          : room.seatsPerRow;
      return Array.from({ length: seatCount }, (_, seatIndex) => ({
        roomId: room.id,
        rowLabel: String.fromCharCode(65 + rowIndex),
        seatNumber: seatIndex + 1,
      }));
    }).flat(),
  ).returning();

  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [session] = await db
    .insert(schema.sessions)
    .values({ movieId: movie.id, roomId: room.id, startsAt, priceCents: 2500 })
    .returning();

  await seedBookedSeats(db, insertedSeats, session.id);

  return session.id;
}

/**
 * Marks a handful of seats as already booked (small groups scattered around
 * the room, like real moviegoers sitting together) so the seat map doesn't
 * look empty on a fresh demo.
 */
async function seedBookedSeats(
  db: PostgresJsDatabase<typeof schema>,
  seats: schema.Seat[],
  sessionId: string,
): Promise<void> {
  const adminUser = await db.query.users.findFirst({
    where: eq(schema.users.email, "admin@movietickets.dev"),
  });
  if (!adminUser) {
    return;
  }

  const seatByLabel = new Map(seats.map((seat) => [`${seat.rowLabel}${seat.seatNumber}`, seat]));
  const alreadyBookedLabels = [
    // A couple, front row
    "B10",
    "B11",
    // Group of friends, mid room
    "F12",
    "F13",
    "F14",
    "F15",
    // Solo moviegoers scattered around
    "D6",
    "H20",
    "J3",
    // Group near the back
    "K16",
    "K17",
    "K18",
    // A couple on the back row
    "M8",
    "M9",
  ];
  const seatIds = alreadyBookedLabels
    .map((label) => seatByLabel.get(label)?.id)
    .filter((id): id is string => id != null);
  if (seatIds.length === 0) {
    return;
  }

  const [booking] = await db
    .insert(schema.bookings)
    .values({ userId: adminUser.id, sessionId, status: "confirmed" })
    .returning();

  await db
    .insert(schema.bookingSeats)
    .values(seatIds.map((seatId) => ({ bookingId: booking.id, sessionId, seatId })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
