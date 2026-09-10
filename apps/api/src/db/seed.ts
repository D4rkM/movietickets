import "dotenv/config";
import * as bcrypt from "bcrypt";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { users } from "./schema";

const SALT_ROUNDS = 10;
const DEV_PASSWORD = "password123";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL não definida");
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema: { users } });

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, SALT_ROUNDS);

  await db
    .insert(users)
    .values([
      { name: "Admin", email: "admin@movietickets.dev", passwordHash, role: "admin" },
      { name: "Cliente", email: "cliente@movietickets.dev", passwordHash, role: "customer" },
    ])
    .onConflictDoNothing({ target: users.email });

  console.log(`Seed ok. Usuários de teste (senha: "${DEV_PASSWORD}"):`);
  console.log("  admin@movietickets.dev (role: admin)");
  console.log("  cliente@movietickets.dev (role: customer)");

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
