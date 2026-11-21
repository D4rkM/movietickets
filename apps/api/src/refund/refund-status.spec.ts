import {
  decideRefundTransition,
  normalizeProviderRefundStatus,
  parseSeatLabel,
  toCustomerRefundStatus,
} from "./refund-status";

describe("refund status rules", () => {
  // AC26: simplified status shown in "Meus ingressos"
  describe("toCustomerRefundStatus", () => {
    it.each([
      ["requested", "pending"],
      ["in_process", "pending"],
      ["approved", "completed"],
      ["failed", "failed"],
      ["rejected", "failed"],
    ])("should map %s to %s", (status, expected) => {
      // ARRANGE / ACT
      const customerStatus = toCustomerRefundStatus(status);

      // ASSERT
      expect(customerStatus).toBe(expected);
    });
  });

  describe("normalizeProviderRefundStatus", () => {
    it.each([
      ["approved", "approved"],
      ["in_process", "in_process"],
      ["pending", "in_process"],
      ["authorized", "in_process"],
      ["rejected", "rejected"],
      ["cancelled", "rejected"],
      [undefined, "rejected"],
      [null, "rejected"],
    ])("should normalize Mercado Pago status %s to %s", (status, expected) => {
      // ARRANGE / ACT
      const normalized = normalizeProviderRefundStatus(status);

      // ASSERT
      expect(normalized).toBe(expected);
    });
  });

  describe("decideRefundTransition (applyRefundStatus table)", () => {
    it.each([
      ["requested", "approved", "accept"],
      ["requested", "in_process", "accept"],
      ["requested", "rejected", "reject"],
      ["in_process", "approved", "complete"],
      ["in_process", "rejected", "reject"],
      ["approved", "rejected", "ignore"],
      ["approved", "in_process", "ignore"],
      ["approved", "approved", "ignore"],
      ["in_process", "in_process", "ignore"],
      ["rejected", "approved", "ignore"],
      ["failed", "approved", "ignore"],
      ["requested", "requested", "ignore"],
      ["requested", "failed", "ignore"],
    ])("should go from %s to %s as %s", (current, next, expected) => {
      // ARRANGE / ACT
      const transition = decideRefundTransition(current, next);

      // ASSERT
      expect(transition).toBe(expected);
    });
  });

  describe("parseSeatLabel", () => {
    it.each([
      ["A1", { rowLabel: "A", seatNumber: 1 }],
      ["B12", { rowLabel: "B", seatNumber: 12 }],
      ["AA3", { rowLabel: "AA", seatNumber: 3 }],
      ["VIP", { rowLabel: "VIP", seatNumber: 0 }],
    ])("should split %s into row and number", (label, expected) => {
      // ARRANGE / ACT
      const seat = parseSeatLabel(label);

      // ASSERT
      expect(seat).toEqual(expected);
    });
  });
});
