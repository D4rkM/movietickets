import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "nestjs-pino";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BookingModule } from "./booking/booking.module";
import { CatalogModule } from "./catalog/catalog.module";
import { DrizzleModule } from "./db/drizzle.module";
import { NotificationModule } from "./notification/notification.module";
import { PaymentModule } from "./payment/payment.module";
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
    ScheduleModule.forRoot(),
    DrizzleModule,
    ValkeyModule,
    AuthModule,
    SeatingModule,
    BookingModule,
    CatalogModule,
    PaymentModule,
    NotificationModule,
    AdminModule,
  ],
})
export class AppModule {}
