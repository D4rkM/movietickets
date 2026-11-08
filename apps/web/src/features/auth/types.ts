export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface SeatRef {
  sessionId: string;
  seatId: string;
}

/** `expired`: the guest's hold ran out before login. `limit`: an older user hold freed to stay within 6 per session. */
export type ReleasedSeatReason = "expired" | "limit";

export interface ReleasedSeat extends SeatRef {
  reason: ReleasedSeatReason;
}

export interface HoldTransfer {
  keptSeats: SeatRef[];
  releasedSeats: ReleasedSeat[];
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
  /** Only present when a usable guestToken was sent along with the credentials. */
  transfer?: HoldTransfer;
}
