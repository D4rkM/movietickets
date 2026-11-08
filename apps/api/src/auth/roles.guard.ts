import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FastifyRequest } from "fastify";
import { isUserPayload } from "./jwt-payload.type";
import { ROLES_KEY } from "./roles.decorator";

/**
 * Role check for routes marked with `@Roles(...)`. Must run after
 * JwtAuthGuard, which verifies the token and attaches its payload to
 * `request.user`. The role comes from the token itself (no database lookup per
 * request), so a demoted admin keeps access until the token expires.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<FastifyRequest>().user;
    if (!user) {
      throw new UnauthorizedException("Token ausente");
    }
    if (!isUserPayload(user) || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException("Acesso restrito a administradores");
    }
    return true;
  }
}
