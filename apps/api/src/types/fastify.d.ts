import { JwtPayload } from "../auth/jwt-payload.type";

declare module "fastify" {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}
