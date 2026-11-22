import { ModuleMetadata, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { MeterProvider } from "@opentelemetry/api";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { AuthModule } from "../../src/auth/auth.module";
import { BookingModule } from "../../src/booking/booking.module";
import { DrizzleModule } from "../../src/db/drizzle.module";
import * as schema from "../../src/db/schema";
import { PAYMENT_CLIENT, REFUND_CLIENT } from "../../src/mercadopago/mercadopago.providers";
import { PaymentModule } from "../../src/payment/payment.module";
import { SeatingModule } from "../../src/seating/seating.module";
import { METER_PROVIDER } from "../../src/telemetry/business-metrics";
import { VALKEY, ValkeyModule } from "../../src/valkey/valkey.module";
import { buildFastifyApp } from "./build-app";

export interface GuestFlowApp {
  app: NestFastifyApplication;
  db: PostgresJsDatabase<typeof schema>;
  valkey: Redis;
  jwtService: JwtService;
  /** http://127.0.0.1:<port>, for the WebSocket client. */
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Boots the full auth + seating + booking + payment (+ refund, imported by
 * payment) stack against the real
 * Postgres/Valkey, listening on a random port so WebSocket clients can
 * connect. Mercado Pago clients are stubbed: no test here ever reaches them.
 */
export async function startGuestFlowApp(
  options: {
    extraImports?: NonNullable<ModuleMetadata["imports"]>;
    /** Records BusinessMetrics into this provider (in-memory telemetry tests) instead of the global no-op one. */
    meterProvider?: MeterProvider;
  } = {},
): Promise<GuestFlowApp> {
  process.env.JWT_SECRET ??= "test-secret";

  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      DrizzleModule,
      ValkeyModule,
      AuthModule,
      SeatingModule,
      BookingModule,
      PaymentModule,
      ...(options.extraImports ?? []),
    ],
  })
    .overrideProvider(PAYMENT_CLIENT)
    .useValue({ create: jest.fn(), get: jest.fn() })
    .overrideProvider(REFUND_CLIENT)
    .useValue({ total: jest.fn() });
  if (options.meterProvider) {
    builder.overrideProvider(METER_PROVIDER).useValue(options.meterProvider);
  }
  const moduleRef = await builder.compile();

  const sqlClient = postgres(process.env.DATABASE_URL!);
  const db = drizzle(sqlClient, { schema });

  const app = await buildFastifyApp(moduleRef);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    app,
    db,
    valkey: moduleRef.get(VALKEY),
    jwtService: moduleRef.get(JwtService),
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await sqlClient.end();
      await app.close();
    },
  };
}
