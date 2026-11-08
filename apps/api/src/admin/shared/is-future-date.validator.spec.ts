import { isFutureDate } from "./is-future-date.validator";

describe("isFutureDate", () => {
  const now = new Date("2030-01-10T19:00:00.000Z");

  it.each([
    ["one minute later (with offset)", "2030-01-10T16:01:00-03:00", true],
    ["exactly now", "2030-01-10T19:00:00.000Z", false],
    ["in the past", "2030-01-10T18:00:00.000Z", false],
    ["a Date in the future", new Date("2031-01-01T00:00:00.000Z"), true],
    ["an unparseable string", "not-a-date", false],
    ["a number", 1_900_000_000_000, false],
  ])("should return %s → %s", (_label, value, expected) => {
    // ARRANGE / ACT
    const result = isFutureDate(value, now);

    // ASSERT
    expect(result).toBe(expected);
  });
});
