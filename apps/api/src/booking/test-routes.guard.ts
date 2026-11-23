import { CanActivate, Injectable, NotFoundException } from "@nestjs/common";

/** Env flag that exposes routes meant only for tests (e.g. the mocked booking confirmation). */
export const ENABLE_TEST_ROUTES_ENV = "ENABLE_TEST_ROUTES";

export function areTestRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_TEST_ROUTES_ENV] === "true";
}

/**
 * Answers 404 as if the route did not exist unless `ENABLE_TEST_ROUTES=true`.
 * Read on every request (not at boot) so it stays testable; place it BEFORE the
 * auth guard so a disabled route never reveals itself with a 401.
 * See docs/flows/test-routes/spec.md.
 */
@Injectable()
export class TestRoutesGuard implements CanActivate {
  canActivate(): boolean {
    if (!areTestRoutesEnabled()) {
      throw new NotFoundException();
    }
    return true;
  }
}
