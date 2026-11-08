import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { FastifyRequest } from "fastify";
import { verifyBearerToken } from "./bearer-token";
import { isUserPayload } from "./jwt-payload.type";

/**
 * User-only guard: accepts a valid user token (with `kind: "user"` or, for
 * tokens issued before guest identities existed, no `kind` at all) and
 * rejects guest tokens with 401. Every route behind it — booking, payment,
 * tickets — stays closed to guests.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const payload = await verifyBearerToken(this.jwtService, request);
    if (!isUserPayload(payload)) {
      throw new UnauthorizedException("Token de convidado não autorizado nesta rota");
    }
    request.user = payload;
    return true;
  }
}
