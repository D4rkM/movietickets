import "dotenv/config";
import * as bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const SALT_ROUNDS = 10;
const DEV_PASSWORD = "password123";
const SAMPLE_MOVIE_TITLE = "Sessão de Teste (seed)";

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
    .values({ name: "Cinema de Teste (seed)", address: "Rua de Teste, 123", city: "Testópolis" })
    .returning();

  const [room] = await db
    .insert(schema.rooms)
    .values({ cinemaId: cinema.id, name: "Sala 1", rows: 2, seatsPerRow: 4 })
    .returning();

  await db.insert(schema.seats).values(
    Array.from({ length: room.rows }, (_, rowIndex) =>
      Array.from({ length: room.seatsPerRow }, (_, seatIndex) => ({
        roomId: room.id,
        rowLabel: String.fromCharCode(65 + rowIndex),
        seatNumber: seatIndex + 1,
      })),
    ).flat(),
  );

  const [session] = await db
    .insert(schema.sessions)
    .values({ movieId: movie.id, roomId: room.id, startsAt: new Date(), priceCents: 2500 })
    .returning();

  return session.id;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
