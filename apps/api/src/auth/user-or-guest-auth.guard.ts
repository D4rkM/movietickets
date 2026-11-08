import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { FastifyRequest } from "fastify";
import { verifyBearerToken } from "./bearer-token";
import { guestIdFromSubject, isGuestPayload, isUserPayload } from "./jwt-payload.type";

/**
 * Accepts either a user token or a guest token. Only meant for the seat-map
 * and hold/release routes, which a visitor can use before logging in.
 */
@Injectable()
export class UserOrGuestAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const payload = await verifyBearerToken(this.jwtService, request);

    const isValidGuest = isGuestPayload(payload) && guestIdFromSubject(payload.sub) !== undefined;
    if (!isValidGuest && !isUserPayload(payload)) {
      throw new UnauthorizedException("Token inválido ou expirado");
    }
    request.user = payload;
    return true;
  }
}
