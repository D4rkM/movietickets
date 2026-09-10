export type SeatState = "free" | "held_by_other" | "held_by_me" | "booked";

export interface SeatMapSeat {
  id: string;
  rowLabel: string;
  seatNumber: number;
  status: SeatState;
}

export interface SeatMapResponse {
  room: { rows: number; seatsPerRow: number };
  priceCents: number;
  seats: SeatMapSeat[];
}
