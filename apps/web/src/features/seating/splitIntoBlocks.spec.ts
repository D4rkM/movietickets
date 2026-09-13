import { describe, expect, it } from "vitest";
import { buildRowSegments, splitIntoBlocks } from "./SeatMap";
import type { SeatMapSeat } from "./types";

function makeSeats(count: number): SeatMapSeat[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `seat-${index + 1}`,
    rowLabel: "A",
    seatNumber: index + 1,
    status: "free",
  }));
}

describe("splitIntoBlocks", () => {
  it("should split a 28-seat row into 4/20/4 left, middle and right blocks", () => {
    // ARRANGE
    const seats = makeSeats(28);

    // ACT
    const blocks = splitIntoBlocks(seats);

    // ASSERT
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveLength(4);
    expect(blocks[1]).toHaveLength(20);
    expect(blocks[2]).toHaveLength(4);
    expect(blocks[0].map((seat) => seat.seatNumber)).toEqual([1, 2, 3, 4]);
    expect(blocks[2].map((seat) => seat.seatNumber)).toEqual([25, 26, 27, 28]);
  });

  it("should not split a short row that doesn't fit two side blocks plus an aisle", () => {
    // ARRANGE
    const seats = makeSeats(4);

    // ACT
    const blocks = splitIntoBlocks(seats);

    // ASSERT
    expect(blocks).toEqual([seats]);
  });
});

describe("buildRowSegments", () => {
  it("should render a single seatless-aisle-free block for the back row", () => {
    // ARRANGE
    const seats = makeSeats(32);

    // ACT
    const segments = buildRowSegments(seats, true);

    // ASSERT
    expect(segments).toEqual([{ seats }]);
  });

  it("should render left/aisle/middle/aisle/right for a full row with side seats", () => {
    // ARRANGE
    const seats = makeSeats(28);

    // ACT
    const segments = buildRowSegments(seats, false);

    // ASSERT
    expect(segments).toHaveLength(5);
    expect(segments[0]).toEqual({ seats: seats.slice(0, 4) });
    expect(segments[1]).toEqual({ gapPx: 88 });
    expect(segments[2]).toEqual({ seats: seats.slice(4, 24) });
    expect(segments[3]).toEqual({ gapPx: 88 });
    expect(segments[4]).toEqual({ seats: seats.slice(24) });
  });

  it("should flank a middle-only row (no side seats) with a side-block-plus-aisle gap, so its first seat lines up with seat 5 of a full row", () => {
    // ARRANGE
    const seats = makeSeats(20);

    // ACT
    const segments = buildRowSegments(seats, false);

    // ASSERT
    expect(segments).toEqual([{ gapPx: 240 }, { seats }, { gapPx: 240 }]);
  });
});
