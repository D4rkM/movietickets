import type { Redis } from "ioredis";
import {
  guestConsumedKey,
  guestHoldMember,
  guestHoldsKey,
  guestIdFromHolder,
  holdKey,
  parseGuestHoldMember,
  scanSessionHoldKeys,
  seatIdFromHoldKey,
} from "./hold-keys";

describe("hold-keys", () => {
  it("should build the seat-hold, guest index and consumed-marker keys", () => {
    // ACT
    const keys = [holdKey("s1", "a1"), guestHoldsKey("g1"), guestConsumedKey("g1"), guestHoldMember("s1", "a1")];

    // ASSERT
    expect(keys).toEqual(["seat-hold:s1:a1", "guest-holds:g1", "guest-consumed:g1", "s1:a1"]);
  });

  it("should extract the seat id from a hold key", () => {
    // ACT
    const seatId = seatIdFromHoldKey("s1", "seat-hold:s1:a1");

    // ASSERT
    expect(seatId).toBe("a1");
  });

  it.each([
    ["s1:a1", { sessionId: "s1", seatId: "a1" }],
    ["s1:", undefined],
    [":a1", undefined],
    ["garbage", undefined],
  ])("should parse guest index member %p", (member, expected) => {
    // ACT
    const parsed = parseGuestHoldMember(member);

    // ASSERT
    expect(parsed).toEqual(expected);
  });

  it.each([
    ["guest:3f1c", "3f1c"],
    ["guest:", undefined],
    ["3f1c-user-id", undefined],
  ])("should resolve the guest id of holder %p", (holder, expected) => {
    // ACT
    const guestId = guestIdFromHolder(holder);

    // ASSERT
    expect(guestId).toBe(expected);
  });

  it("should follow the SCAN cursor until it returns to zero", async () => {
    // ARRANGE
    const scan = jest
      .fn()
      .mockResolvedValueOnce(["9", ["seat-hold:s1:a1"]])
      .mockResolvedValueOnce(["0", ["seat-hold:s1:a2"]]);

    // ACT
    const keys = await scanSessionHoldKeys({ scan } as unknown as Redis, "s1");

    // ASSERT
    expect(scan).toHaveBeenCalledWith("0", "MATCH", "seat-hold:s1:*", "COUNT", 100);
    expect(scan).toHaveBeenCalledWith("9", "MATCH", "seat-hold:s1:*", "COUNT", 100);
    expect(keys).toEqual(["seat-hold:s1:a1", "seat-hold:s1:a2"]);
  });
});
