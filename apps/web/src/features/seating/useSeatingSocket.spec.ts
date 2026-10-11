import { describe, expect, it } from "vitest";
import { toSeatState } from "./useSeatingSocket";

describe("toSeatState", () => {
  it("should map a booked event to booked regardless of who held it", () => {
    // ARRANGE
    const event = { seatId: "seat-1", status: "booked" as const, heldByUserId: "someone-else" };

    // ACT
    const result = toSeatState(event, "user-1");

    // ASSERT
    expect(result).toBe("booked");
  });

  it("should map a released event to free", () => {
    // ARRANGE
    const event = { seatId: "seat-1", status: "released" as const };

    // ACT
    const result = toSeatState(event, "user-1");

    // ASSERT
    expect(result).toBe("free");
  });

  it("should map a held event to held_by_me when it's the current user's hold", () => {
    // ARRANGE
    const event = { seatId: "seat-1", status: "held" as const, heldByUserId: "user-1" };

    // ACT
    const result = toSeatState(event, "user-1");

    // ASSERT
    expect(result).toBe("held_by_me");
  });

  it("should map a held event to held_by_other when another user holds it", () => {
    // ARRANGE
    const event = { seatId: "seat-1", status: "held" as const, heldByUserId: "someone-else" };

    // ACT
    const result = toSeatState(event, "user-1");

    // ASSERT
    expect(result).toBe("held_by_other");
  });
});
