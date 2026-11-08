import type { Redis } from "ioredis";
import { guestIdFromSubject } from "../auth/jwt-payload.type";

export const HOLD_KEY_PREFIX = "seat-hold";
export const HOLD_TTL_SECONDS = 600;
export const MAX_HELD_SEATS_PER_USER = 6;

/** Set of `<sessionId>:<seatId>` members held by one guest, so login can find them without SCAN. */
export const GUEST_HOLDS_KEY_PREFIX = "guest-holds";
/** Single-use marker: set once a guest token's holds were transferred to a user. */
export const GUEST_CONSUMED_KEY_PREFIX = "guest-consumed";

export interface SeatRef {
  sessionId: string;
  seatId: string;
}

export function holdKey(sessionId: string, seatId: string): string {
  return `${HOLD_KEY_PREFIX}:${sessionId}:${seatId}`;
}

export function seatIdFromHoldKey(sessionId: string, key: string): string {
  return key.slice(`${HOLD_KEY_PREFIX}:${sessionId}:`.length);
}

export function guestHoldsKey(guestId: string): string {
  return `${GUEST_HOLDS_KEY_PREFIX}:${guestId}`;
}

export function guestConsumedKey(guestId: string): string {
  return `${GUEST_CONSUMED_KEY_PREFIX}:${guestId}`;
}

export function guestHoldMember(sessionId: string, seatId: string): string {
  return `${sessionId}:${seatId}`;
}

export function parseGuestHoldMember(member: string): SeatRef | undefined {
  const [sessionId, seatId] = member.split(":");
  if (!sessionId || !seatId) return undefined;
  return { sessionId, seatId };
}

/** Guest id (`<uuid>`) when the hold owner is a guest (`guest:<uuid>`), undefined for a user id. */
export function guestIdFromHolder(holderId: string): string | undefined {
  return guestIdFromSubject(holderId);
}

/** Every `seat-hold:<sessionId>:*` key currently in Valkey, following the SCAN cursor to the end. */
export async function scanSessionHoldKeys(valkey: Redis, sessionId: string): Promise<string[]> {
  const pattern = `${HOLD_KEY_PREFIX}:${sessionId}:*`;
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, found] = await valkey.scan(cursor, "MATCH", pattern, "COUNT", 100);
    keys.push(...found);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}
