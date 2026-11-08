import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";

/** Restricts a controller or route to users whose token `role` is one of the given roles (enforced by RolesGuard). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
