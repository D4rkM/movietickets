import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { SeatingModule } from "../seating/seating.module";
import { AuthTokenModule } from "./auth-token.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { GUEST_TOKEN_RATE_LIMIT } from "./guest-token.constants";

@Module({
  imports: [
    AuthTokenModule,
    SeatingModule,
    // In-memory, per-instance storage. Only applied where ThrottlerGuard is
    // used explicitly (POST /auth/guest); not registered as a global guard.
    ThrottlerModule.forRoot([GUEST_TOKEN_RATE_LIMIT]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  // Re-exported so modules that import AuthModule for JwtAuthGuard keep working.
  exports: [AuthTokenModule],
})
export class AuthModule {}
