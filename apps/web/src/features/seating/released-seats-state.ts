import type { ReleasedSeat } from "../auth/types";

/**
 * Router state LoginPage hands to the page it returns to after a login that
 * transferred guest holds. Router state (not storage) on purpose: it only
 * lives for that one navigation, so the notice can't resurface later.
 */
export interface ReleasedSeatsNoticeState {
  releasedSeats: ReleasedSeat[];
}

export function readReleasedSeatsState(state: unknown): ReleasedSeat[] {
  const releasedSeats = (state as Partial<ReleasedSeatsNoticeState> | null)?.releasedSeats;
  return Array.isArray(releasedSeats) ? releasedSeats : [];
}
