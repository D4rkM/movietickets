import { Module } from "@nestjs/common";
import { AuthTokenModule } from "./auth-token.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [AuthTokenModule],
  controllers: [AuthController],
  providers: [AuthService],
  // Re-exported so modules that import AuthModule for JwtAuthGuard keep working.
  exports: [AuthTokenModule],
})
export class AuthModule {}
