import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { AuthModule } from "./auth/auth.module";
import { DrizzleModule } from "./db/drizzle.module";

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
    AuthModule,
  ],
})
export class AppModule {}
