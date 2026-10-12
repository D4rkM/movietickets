import { parseHoldKey } from "./hold-expiry.listener";

describe("parseHoldKey", () => {
  it("should parse a well-formed hold key into its session and seat ids", () => {
    // ARRANGE
    const key = "seat-hold:session-1:seat-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toEqual({ sessionId: "session-1", seatId: "seat-1" });
  });

  it("should return undefined for a key that isn't a seat hold", () => {
    // ARRANGE
    const key = "some-other-key:session-1:seat-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toBeUndefined();
  });

  it("should return undefined when the key is missing a segment", () => {
    // ARRANGE
    const key = "seat-hold:session-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toBeUndefined();
  });
});
