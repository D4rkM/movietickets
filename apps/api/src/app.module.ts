import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { AuthModule } from "./auth/auth.module";
import { BookingModule } from "./booking/booking.module";
import { DrizzleModule } from "./db/drizzle.module";
import { SeatingModule } from "./seating/seating.module";
import { ValkeyModule } from "./valkey/valkey.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL", "info"),
          transport:
            config.get("NODE_ENV") === "production"
              ? undefined
              : { target: "pino-pretty", options: { singleLine: true } },
          redact: ["req.headers.authorization", "req.body.password"],
        },
      }),
    }),
    DrizzleModule,
    ValkeyModule,
    AuthModule,
    SeatingModule,
    BookingModule,
  ],
})
export class AppModule {}
