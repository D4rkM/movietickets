import { intervalsOverlap, sessionInterval } from "./session-overlap";

const at = (time: string) => new Date(`2030-01-10T${time}:00.000Z`);

describe("session-overlap", () => {
  it("should compute the session interval as [startsAt, startsAt + duration)", () => {
    // ARRANGE
    const startsAt = at("19:00");

    // ACT
    const interval = sessionInterval(startsAt, 135);

    // ASSERT
    expect(interval).toEqual({ start: at("19:00"), end: at("21:15") });
  });

  it.each([
    ["touching: B starts exactly when A ends", ["19:00", "21:00"], ["21:00", "23:00"], false],
    ["touching: B ends exactly when A starts", ["19:00", "21:00"], ["17:00", "19:00"], false],
    ["disjoint", ["19:00", "21:00"], ["22:00", "23:00"], false],
    ["partial: B starts inside A", ["19:00", "21:00"], ["20:59", "22:00"], true],
    ["partial: B ends inside A", ["19:00", "21:00"], ["17:30", "19:30"], true],
    ["contained: B inside A", ["19:00", "22:00"], ["20:00", "20:30"], true],
    ["containing: A inside B", ["20:00", "20:30"], ["19:00", "22:00"], true],
    ["identical", ["19:00", "21:00"], ["19:00", "21:00"], true],
  ])("should report %s as overlap=%s", (_label, a, b, expected) => {
    // ARRANGE
    const first = { start: at(a[0]), end: at(a[1]) };
    const second = { start: at(b[0]), end: at(b[1]) };

    // ACT
    const result = intervalsOverlap(first, second);

    // ASSERT
    expect(result).toBe(expected);
  });
});
