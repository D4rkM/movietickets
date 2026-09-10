import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const DRIZZLE = Symbol("DRIZZLE");

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.getOrThrow<string>("DATABASE_URL");
        const client = postgres(connectionString);
        const db = drizzle(client, { schema });
        return Object.assign(db, { onModuleDestroy: () => client.end() });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
