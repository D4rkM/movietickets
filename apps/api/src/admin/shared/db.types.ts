import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../db/schema";

export type Db = PostgresJsDatabase<typeof schema>;

/** The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
