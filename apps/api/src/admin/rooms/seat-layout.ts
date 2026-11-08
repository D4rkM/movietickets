export const MAX_ROOM_ROWS = 26;
export const MAX_SEATS_PER_ROW = 40;

export interface SeatPosition {
  rowLabel: string;
  seatNumber: number;
}

/** Row 0 is "A", row 25 is "Z" (same labelling as the seed). */
export function rowLabelFor(rowIndex: number): string {
  return String.fromCharCode(65 + rowIndex);
}

/** Rectangular layout: rows "A".. with seats numbered 1..seatsPerRow in each. */
export function generateSeatLayout(rows: number, seatsPerRow: number): SeatPosition[] {
  const seats: SeatPosition[] = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    for (let seatNumber = 1; seatNumber <= seatsPerRow; seatNumber++) {
      seats.push({ rowLabel: rowLabelFor(rowIndex), seatNumber });
    }
  }
  return seats;
}
