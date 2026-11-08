import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { FastifyRequest } from "fastify";
import { JwtPayload } from "./jwt-payload.type";

/**
 * Shared by every HTTP auth guard: pulls the Bearer token off the request and
 * verifies its signature/expiry. Which `kind` of token is acceptable is left
 * to each guard.
 */
export async function verifyBearerToken(jwtService: JwtService, request: FastifyRequest): Promise<JwtPayload> {
  const [type, token] = request.headers.authorization?.split(" ") ?? [];
  if (type !== "Bearer" || !token) {
    throw new UnauthorizedException("Token ausente");
  }

  try {
    return await jwtService.verifyAsync<JwtPayload>(token);
  } catch {
    throw new UnauthorizedException("Token inválido ou expirado");
  }
}
