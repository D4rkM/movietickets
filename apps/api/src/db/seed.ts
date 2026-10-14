import "dotenv/config";
import * as bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const SALT_ROUNDS = 10;
const DEV_PASSWORD = "password123";
export const SAMPLE_MOVIE_TITLE = "Vingadores Ultimato";
const MIN_SESSION_DAYS_AHEAD = 3;
const MAX_SESSION_DAYS_AHEAD = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Random date 3-7 days out, so the sample session never ages into the past. */
export function randomFutureSessionDate(): Date {
  const daysAhead =
    MIN_SESSION_DAYS_AHEAD + Math.floor(Math.random() * (MAX_SESSION_DAYS_AHEAD - MIN_SESSION_DAYS_AHEAD + 1));
  return new Date(Date.now() + daysAhead * MS_PER_DAY);
}

const MIN_CATALOG_SESSION_MS = MS_PER_HOUR;
const MAX_CATALOG_SESSION_MS = 7 * MS_PER_DAY;

/** Random date 1 hour to 7 days out — wider/closer window than the sample session's, so the catalog demo has some sessions starting soon. */
export function randomCatalogSessionDate(): Date {
  const offsetMs = MIN_CATALOG_SESSION_MS + Math.random() * (MAX_CATALOG_SESSION_MS - MIN_CATALOG_SESSION_MS);
  return new Date(Date.now() + offsetMs);
}

export const CATALOG_MOVIE_TITLES = [
  "It: A Coisa",
  "Ainda Estou Aqui",
  "Da Magia à Sedução",
  "Interestelar",
  "Star Wars: A Vingança dos Sith",
  "Star Wars: A Ameaça Fantasma",
  "Verity",
  "A Empregada",
  "A Hipótese do Amor",
  "Caçadores de Estrelas",
  "Beetlejuice",
];

const CATALOG_MOVIE_DURATION_MINUTES = 120;
const CATALOG_ROOM_ROWS = 8;
const CATALOG_ROOM_SEATS_PER_ROW = 10;
const CATALOG_SESSION_PRICE_CENTS = 3000;

const CATALOG_STREET_NAMES = [
  "Rua das Flores",
  "Av. Paulista",
  "Rua XV de Novembro",
  "Av. Brasil",
  "Rua Sete de Setembro",
  "Av. Rio Branco",
  "Rua da Praia",
  "Av. Atlântica",
];
const CATALOG_CITIES = [
  "São Paulo",
  "Rio de Janeiro",
  "Belo Horizonte",
  "Curitiba",
  "Porto Alegre",
  "Recife",
  "Salvador",
  "Fortaleza",
];

/** Random (fake) street address + city, for cinemas created around the catalog demo movies. */
export function randomCinemaAddress(): { address: string; city: string } {
  const street = CATALOG_STREET_NAMES[Math.floor(Math.random() * CATALOG_STREET_NAMES.length)];
  const number = 1 + Math.floor(Math.random() * 2000);
  const city = CATALOG_CITIES[Math.floor(Math.random() * CATALOG_CITIES.length)];
  return { address: `${street}, ${number}`, city };
}

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
      // Second customer, for manually testing WebSocket seat-map broadcasts
      // and concurrent seat holds — needs two different logged-in users.
      { name: "Cliente 2", email: "cliente2@movietickets.dev", passwordHash, role: "customer" },
    ])
    .onConflictDoNothing({ target: schema.users.email });

  const sessionId = await seedSampleSession(db);
  await seedCatalogMovies(db);

  console.log(`Seed ok. Usuários de teste (senha: "${DEV_PASSWORD}"):`);
  console.log("  admin@movietickets.dev (role: admin)");
  console.log("  cliente@movietickets.dev (role: customer)");
  console.log("  cliente2@movietickets.dev (role: customer)");
  console.log(`Sessão de teste pra GET /sessions/:id/seats: ${sessionId}`);
  console.log(`Filmes de catálogo: ${CATALOG_MOVIE_TITLES.length}`);

  await client.end();
}

/**
 * Creates (or reuses, if already seeded) one movie/cinema/room/session per
 * title in CATALOG_MOVIE_TITLES, each with its own random address and a
 * session starting 1 hour to 7 days out — gives the catalog page (and its
 * city/cinema/date filters) more than the single sample movie to show.
 */
export async function seedCatalogMovies(db: PostgresJsDatabase<typeof schema>): Promise<void> {
  for (const title of CATALOG_MOVIE_TITLES) {
    const existingMovie = await db.query.movies.findFirst({ where: eq(schema.movies.title, title) });
    if (existingMovie) {
      const existingSession = await db.query.sessions.findFirst({
        where: eq(schema.sessions.movieId, existingMovie.id),
      });
      if (existingSession) {
        // Re-rolled on every run, same reasoning as seedSampleSession: otherwise
        // the session ages out of the catalog's "future sessions only" filter.
        await db
          .update(schema.sessions)
          .set({ startsAt: randomCatalogSessionDate() })
          .where(eq(schema.sessions.id, existingSession.id));
      }
      continue;
    }

    const [movie] = await db
      .insert(schema.movies)
      .values({ title, durationMinutes: CATALOG_MOVIE_DURATION_MINUTES })
      .returning();

    const { address, city } = randomCinemaAddress();
    const [cinema] = await db.insert(schema.cinemas).values({ name: `Cine ${city}`, address, city }).returning();

    const [room] = await db
      .insert(schema.rooms)
      .values({ cinemaId: cinema.id, name: "Sala 1", rows: CATALOG_ROOM_ROWS, seatsPerRow: CATALOG_ROOM_SEATS_PER_ROW })
      .returning();

    await db.insert(schema.seats).values(
      Array.from({ length: CATALOG_ROOM_ROWS }, (_, rowIndex) =>
        Array.from({ length: CATALOG_ROOM_SEATS_PER_ROW }, (_, seatIndex) => ({
          roomId: room.id,
          rowLabel: String.fromCharCode(65 + rowIndex),
          seatNumber: seatIndex + 1,
        })),
      ).flat(),
    );

    await db.insert(schema.sessions).values({
      movieId: movie.id,
      roomId: room.id,
      startsAt: randomCatalogSessionDate(),
      priceCents: CATALOG_SESSION_PRICE_CENTS,
    });
  }
}

/** Creates (or reuses, if already seeded) a movie/cinema/room/seats/session fixture for manual testing. */
export async function seedSampleSession(db: PostgresJsDatabase<typeof schema>): Promise<string> {
  const existingMovie = await db.query.movies.findFirst({
    where: eq(schema.movies.title, SAMPLE_MOVIE_TITLE),
  });
  if (existingMovie) {
    const existingSession = await db.query.sessions.findFirst({
      where: eq(schema.sessions.movieId, existingMovie.id),
    });
    if (existingSession) {
      // Re-rolled on every run so the sample session never ages out of the
      // catalog's "future sessions only" filter — otherwise it'd only ever
      // show up once, right after the first seed.
      await db
        .update(schema.sessions)
        .set({ startsAt: randomFutureSessionDate() })
        .where(eq(schema.sessions.id, existingSession.id));
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

  const [session] = await db
    .insert(schema.sessions)
    .values({ movieId: movie.id, roomId: room.id, startsAt: randomFutureSessionDate(), priceCents: 2500 })
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
