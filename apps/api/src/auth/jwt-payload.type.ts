/**
 * Access token issued by POST /auth/login. `kind` is optional on purpose:
 * tokens signed before guest identities existed carry no `kind` at all and
 * must keep being treated as user tokens, so nobody gets logged out on deploy.
 */
export type UserJwtPayload = {
  kind?: "user";
  sub: string;
  email: string;
  role: string;
};

/**
 * Guest token issued by POST /auth/guest. `sub` is `guest:<uuid>` so it can be
 * stored as a seat-hold owner without ever colliding with a user id. Carries
 * no email/role: it only authorizes reading the seat map and holding/releasing
 * seats.
 */
export type GuestJwtPayload = {
  kind: "guest";
  sub: string;
};

export type JwtPayload = UserJwtPayload | GuestJwtPayload;

export const GUEST_SUBJECT_PREFIX = "guest:";

export function isGuestPayload(payload: JwtPayload): payload is GuestJwtPayload {
  return payload.kind === "guest";
}

/** A missing `kind` means a legacy user token. Any other value is rejected. */
export function isUserPayload(payload: JwtPayload): payload is UserJwtPayload {
  return payload.kind === undefined || payload.kind === "user";
}

/** Extracts the `<uuid>` part of a guest subject (`guest:<uuid>`). */
export function guestIdFromSubject(subject: string): string | undefined {
  if (!subject.startsWith(GUEST_SUBJECT_PREFIX)) return undefined;
  const guestId = subject.slice(GUEST_SUBJECT_PREFIX.length);
  return guestId.length > 0 ? guestId : undefined;
}
