import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtModuleOptions } from "@nestjs/jwt";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { UserOrGuestAuthGuard } from "./user-or-guest-auth.guard";

/**
 * JWT signing/verification plus the HTTP guards, split out of AuthModule so
 * SeatingModule can use them without importing AuthModule — AuthModule itself
 * depends on SeatingModule (login transfers guest seat holds), and importing
 * it back would create a module cycle.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: {
          expiresIn: config.get("JWT_EXPIRES_IN", "1h") as NonNullable<JwtModuleOptions["signOptions"]>["expiresIn"],
        },
      }),
    }),
  ],
  providers: [JwtAuthGuard, UserOrGuestAuthGuard, RolesGuard],
  exports: [JwtAuthGuard, UserOrGuestAuthGuard, RolesGuard, JwtModule],
})
export class AuthTokenModule {}
