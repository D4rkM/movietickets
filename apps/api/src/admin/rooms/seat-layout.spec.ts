import { generateSeatLayout, rowLabelFor } from "./seat-layout";

describe("seat-layout", () => {
  it("should generate rows × seatsPerRow seats, rows from A and seats from 1", () => {
    // ARRANGE
    const rows = 3;
    const seatsPerRow = 4;

    // ACT
    const seats = generateSeatLayout(rows, seatsPerRow);

    // ASSERT
    expect(seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`)).toEqual([
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4",
      "C1", "C2", "C3", "C4",
    ]);
  });

  it("should end the 26th row at Z and number the largest room up to 40", () => {
    // ARRANGE
    const rows = 26;
    const seatsPerRow = 40;

    // ACT
    const seats = generateSeatLayout(rows, seatsPerRow);

    // ASSERT
    expect(seats).toHaveLength(1040);
    expect(seats.at(-1)).toEqual({ rowLabel: "Z", seatNumber: 40 });
    expect(new Set(seats.map((seat) => seat.rowLabel)).size).toBe(26);
  });

  it.each([
    [0, "A"],
    [1, "B"],
    [25, "Z"],
  ])("should label row index %i as %s", (rowIndex, label) => {
    // ARRANGE / ACT
    const result = rowLabelFor(rowIndex);

    // ASSERT
    expect(result).toBe(label);
  });
});
