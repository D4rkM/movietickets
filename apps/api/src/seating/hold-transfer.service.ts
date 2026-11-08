import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { GUEST_SUBJECT_PREFIX } from "../auth/jwt-payload.type";
import { VALKEY } from "../valkey/valkey.module";
import {
  guestConsumedKey,
  guestHoldsKey,
  holdKey,
  MAX_HELD_SEATS_PER_USER,
  parseGuestHoldMember,
  scanSessionHoldKeys,
  SeatRef,
  seatIdFromHoldKey,
} from "./hold-keys";
import { SeatingGateway } from "./seating.gateway";

/**
 * Atomic compare-and-swap over every hold the guest had: a key is only
 * rewritten when its current owner is still the guest, and `KEEPTTL`
 * preserves the remaining TTL instead of granting a fresh 600s. A key that is
 * gone (expired) or now belongs to someone else is never recreated.
 *
 * KEYS: seat-hold keys listed in the guest's index.
 * ARGV[1]: guest owner value (`guest:<uuid>`). ARGV[2]: user id.
 * Returns one status per key: "transferred" | "owned" (already the user's) | "expired".
 */
export const TRANSFER_GUEST_HOLDS_SCRIPT = `
local results = {}
for i, key in ipairs(KEYS) do
  local holder = redis.call("GET", key)
  if holder == ARGV[1] then
    redis.call("SET", key, ARGV[2], "KEEPTTL")
    results[i] = "transferred"
  elseif holder == ARGV[2] then
    results[i] = "owned"
  else
    results[i] = "expired"
  end
end
return results
`;

/**
 * Deletes each key only if it is still owned by ARGV[1] (compare-and-delete),
 * so a hold that changed hands since it was read is never touched.
 * Returns the keys actually deleted.
 */
export const RELEASE_IF_OWNED_SCRIPT = `
local released = {}
for _, key in ipairs(KEYS) do
  if redis.call("GET", key) == ARGV[1] then
    redis.call("DEL", key)
    released[#released + 1] = key
  end
end
return released
`;

type TransferStatus = "transferred" | "owned" | "expired";

export interface ReleasedSeat extends SeatRef {
  reason: "expired" | "limit";
}

export interface HoldTransferResult {
  keptSeats: SeatRef[];
  releasedSeats: ReleasedSeat[];
}

export interface UserHoldAge {
  key: string;
  pttl: number;
}

/**
 * Picks which of the user's pre-existing holds in a session must go so that
 * `keptCount` (guest seats, always kept) plus the user's remaining holds fit
 * the per-session limit. Every hold starts at the same TTL, so the lowest
 * PTTL is the oldest hold — those are released first.
 */
export function selectOldestHoldsToRelease(
  userHolds: UserHoldAge[],
  keptCount: number,
  maxHolds: number = MAX_HELD_SEATS_PER_USER,
): UserHoldAge[] {
  const allowedUserHolds = Math.max(0, maxHolds - keptCount);
  const excess = userHolds.length - allowedUserHolds;
  if (excess <= 0) return [];
  return [...userHolds].sort((a, b) => a.pttl - b.pttl).slice(0, excess);
}

/**
 * Moves a guest's seat holds to the user who just logged in with that guest
 * token. Called by AuthService only after the password check succeeded.
 */
@Injectable()
export class HoldTransferService {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly gateway: SeatingGateway,
  ) {}

  /**
   * Returns undefined when the guest token was already consumed by an earlier
   * login (single use). Otherwise claims it, transfers every still-active
   * hold, and enforces the per-session limit by releasing the user's oldest
   * holds in the affected sessions only.
   *
   * @param tokenExpiresAtSeconds guest token `exp` claim, so the consumed
   *   marker lives exactly as long as the token could still be replayed.
   */
  async transferGuestHolds(
    guestId: string,
    userId: string,
    tokenExpiresAtSeconds: number,
  ): Promise<HoldTransferResult | undefined> {
    const claimed = await this.claimGuest(guestId, tokenExpiresAtSeconds);
    if (!claimed) return undefined;

    const indexKey = guestHoldsKey(guestId);
    const seats = (await this.valkey.smembers(indexKey))
      .map(parseGuestHoldMember)
      .filter((seat): seat is SeatRef => seat !== undefined);

    const result: HoldTransferResult = { keptSeats: [], releasedSeats: [] };
    if (seats.length > 0) {
      await this.moveHolds(seats, `${GUEST_SUBJECT_PREFIX}${guestId}`, userId, result);
      await this.enforceLimitPerSession(result.keptSeats, userId, result);
    }

    await this.valkey.del(indexKey);
    return result;
  }

  /** SET NX makes the claim itself atomic, so two concurrent logins can't both transfer. */
  private async claimGuest(guestId: string, tokenExpiresAtSeconds: number): Promise<boolean> {
    const remainingSeconds = Math.max(1, Math.ceil(tokenExpiresAtSeconds - Date.now() / 1000));
    const claimed = await this.valkey.set(guestConsumedKey(guestId), "1", "EX", remainingSeconds, "NX");
    return claimed === "OK";
  }

  private async moveHolds(
    seats: SeatRef[],
    guestHolder: string,
    userId: string,
    result: HoldTransferResult,
  ): Promise<void> {
    const keys = seats.map((seat) => holdKey(seat.sessionId, seat.seatId));
    const statuses = (await this.valkey.eval(
      TRANSFER_GUEST_HOLDS_SCRIPT,
      keys.length,
      ...keys,
      guestHolder,
      userId,
    )) as TransferStatus[];

    seats.forEach((seat, index) => {
      const status = statuses[index];
      if (status === "expired") {
        result.releasedSeats.push({ ...seat, reason: "expired" });
        return;
      }
      result.keptSeats.push(seat);
      if (status === "transferred") {
        this.gateway.broadcastSeatUpdate(seat.sessionId, {
          seatId: seat.seatId,
          status: "held",
          heldByUserId: userId,
        });
      }
    });
  }

  private async enforceLimitPerSession(
    keptSeats: SeatRef[],
    userId: string,
    result: HoldTransferResult,
  ): Promise<void> {
    const keptBySession = new Map<string, Set<string>>();
    for (const seat of keptSeats) {
      const seatIds = keptBySession.get(seat.sessionId) ?? new Set<string>();
      seatIds.add(seat.seatId);
      keptBySession.set(seat.sessionId, seatIds);
    }

    for (const [sessionId, keptSeatIds] of keptBySession) {
      const userHolds = await this.findOtherUserHolds(sessionId, userId, keptSeatIds);
      const toRelease = selectOldestHoldsToRelease(userHolds, keptSeatIds.size);
      if (toRelease.length === 0) continue;

      const releasedKeys = (await this.valkey.eval(
        RELEASE_IF_OWNED_SCRIPT,
        toRelease.length,
        ...toRelease.map((hold) => hold.key),
        userId,
      )) as string[];

      for (const key of releasedKeys) {
        const seatId = seatIdFromHoldKey(sessionId, key);
        result.releasedSeats.push({ sessionId, seatId, reason: "limit" });
        this.gateway.broadcastSeatUpdate(sessionId, { seatId, status: "released" });
      }
    }
  }

  /** The user's holds in a session that did not come from the guest, with their remaining TTL. */
  private async findOtherUserHolds(
    sessionId: string,
    userId: string,
    excludedSeatIds: Set<string>,
  ): Promise<UserHoldAge[]> {
    const keys = (await scanSessionHoldKeys(this.valkey, sessionId)).filter(
      (key) => !excludedSeatIds.has(seatIdFromHoldKey(sessionId, key)),
    );
    if (keys.length === 0) return [];

    const owners = await this.valkey.mget(...keys);
    const ownedKeys = keys.filter((_, index) => owners[index] === userId);
    if (ownedKeys.length === 0) return [];

    const pipeline = this.valkey.pipeline();
    ownedKeys.forEach((key) => pipeline.pttl(key));
    const pttls = (await pipeline.exec()) ?? [];

    return ownedKeys
      .map((key, index) => ({ key, pttl: Number(pttls[index]?.[1] ?? -2) }))
      .filter((hold) => hold.pttl !== -2);
  }
}
