import { describe, expect, it } from "vitest";
import { isRefundReconcile, refundStatusLabel, reviewReasonLabel } from "./refund-labels";
import type { AdminRefundStatus, RefundReviewItem, RefundReviewReason } from "./types";

describe("reviewReasonLabel", () => {
  it.each([
    ["expired_booking_paid", "Pagamento aprovado em reserva expirada"],
    ["refund_rejected", "Estorno recusado"],
    ["refund_stalled", "Estorno parado"],
  ] as const)("should translate %s", (reason: RefundReviewReason, expected) => {
    // ARRANGE
    const input = reason;

    // ACT
    const label = reviewReasonLabel(input);

    // ASSERT
    expect(label).toBe(expected);
  });
});

describe("refundStatusLabel", () => {
  it.each([
    ["requested", "Solicitado"],
    ["in_process", "Em processamento"],
    ["approved", "Aprovado"],
    ["rejected", "Recusado"],
    ["failed", "Falhou"],
    [null, "—"],
  ] as const)("should translate %s", (status: AdminRefundStatus | null, expected) => {
    // ARRANGE
    const input = status;

    // ACT
    const label = refundStatusLabel(input);

    // ASSERT
    expect(label).toBe(expected);
  });
});

describe("isRefundReconcile", () => {
  it.each([
    ["in_process", true],
    ["requested", false],
    ["rejected", false],
    [null, false],
  ] as const)("should decide for a last refund %s", (status, expected) => {
    // ARRANGE
    const item = {
      refund: status ? { id: "r-1", status, errorCode: null, updatedAt: "2026-11-20T12:00:00.000Z" } : null,
    } as RefundReviewItem;

    // ACT
    const result = isRefundReconcile(item);

    // ASSERT
    expect(result).toBe(expected);
  });
});
