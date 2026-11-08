import { hasStarted, SessionActivity, sessionDeleteBlockReason, sessionEditBlockReason } from "./session-edit-policy";

const idle: SessionActivity = {
  hasPendingBooking: false,
  hasConfirmedBooking: false,
  hasAnyBooking: false,
  hasActiveHold: false,
};
const pending: SessionActivity = { ...idle, hasPendingBooking: true, hasAnyBooking: true };
const confirmed: SessionActivity = { ...idle, hasConfirmedBooking: true, hasAnyBooking: true };
const cancelledOnly: SessionActivity = { ...idle, hasAnyBooking: true };
const held: SessionActivity = { ...idle, hasActiveHold: true };

describe("session-edit-policy", () => {
  describe("sessionEditBlockReason", () => {
    it.each([
      ["schedule change, no activity", { schedule: true, price: false }, idle, false],
      ["schedule change, only cancelled bookings", { schedule: true, price: false }, cancelledOnly, false],
      ["schedule change, pending booking", { schedule: true, price: false }, pending, true],
      ["schedule change, confirmed booking", { schedule: true, price: false }, confirmed, true],
      ["schedule change, active hold", { schedule: true, price: false }, held, true],
      ["price change, no activity", { schedule: false, price: true }, idle, false],
      ["price change, only confirmed bookings", { schedule: false, price: true }, confirmed, false],
      ["price change, pending booking", { schedule: false, price: true }, pending, true],
      ["price change, active hold", { schedule: false, price: true }, held, true],
      ["schedule + price change, only confirmed bookings", { schedule: true, price: true }, confirmed, true],
    ])("should decide blocked=%s for %s", (_label, changes, activity, blocked) => {
      // ARRANGE / ACT
      const reason = sessionEditBlockReason(changes, activity);

      // ASSERT
      expect(reason !== undefined).toBe(blocked);
    });
  });

  describe("sessionDeleteBlockReason", () => {
    it.each([
      ["no activity", idle, false],
      ["a pending booking", pending, true],
      ["a confirmed booking", confirmed, true],
      ["only a cancelled booking", cancelledOnly, true],
      ["an active hold", held, true],
    ])("should decide blocked for %s", (_label, activity, blocked) => {
      // ARRANGE / ACT
      const reason = sessionDeleteBlockReason(activity);

      // ASSERT
      expect(reason !== undefined).toBe(blocked);
    });
  });

  describe("hasStarted", () => {
    const now = new Date("2030-01-10T19:00:00.000Z");

    it.each([
      ["one minute ago", "2030-01-10T18:59:00.000Z", true],
      ["exactly now", "2030-01-10T19:00:00.000Z", true],
      ["one minute from now", "2030-01-10T19:01:00.000Z", false],
    ])("should consider a session starting %s as started=%s", (_label, startsAt, expected) => {
      // ARRANGE / ACT
      const result = hasStarted(new Date(startsAt), now);

      // ASSERT
      expect(result).toBe(expected);
    });
  });
});
