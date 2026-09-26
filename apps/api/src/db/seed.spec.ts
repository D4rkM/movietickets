import { randomFutureSessionDate } from "./seed";

describe("randomFutureSessionDate", () => {
  it("should return a date at least 3 days ahead", () => {
    // ARRANGE
    const before = Date.now();

    // ACT
    const result = randomFutureSessionDate();

    // ASSERT
    const minMs = before + 3 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(minMs);
  });

  it("should return a date at most 7 days ahead", () => {
    // ARRANGE
    const before = Date.now();

    // ACT
    const result = randomFutureSessionDate();

    // ASSERT
    const maxMs = before + 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeLessThanOrEqual(maxMs);
  });

  it("should vary across calls instead of always returning the same offset", () => {
    // ARRANGE
    const samples = Array.from({ length: 20 }, () => randomFutureSessionDate().getTime());

    // ACT
    const uniqueValues = new Set(samples);

    // ASSERT
    expect(uniqueValues.size).toBeGreaterThan(1);
  });
});
