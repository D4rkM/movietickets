/**
 * Refund statuses and pure mapping rules shared by the refund flow, the
 * webhook and "Meus ingressos". Kept free of Nest/DB imports so BookingModule
 * can use them without importing RefundModule (which imports BookingModule).
 */

export type RefundStatus = "requested" | "failed" | "in_process" | "approved" | "rejected";

export type RefundReason =
  | "customer_cancellation"
  | "expired_booking_review"
  | "external"
  | "session_cancelled";

/** Simplified refund status shown to the customer. */
export type CustomerRefundStatus = "pending" | "completed" | "failed";

/** Statuses covered by the `refunds_active_per_payment_uq` partial unique index. */
export const ACTIVE_REFUND_STATUSES: RefundStatus[] = ["requested", "in_process", "approved"];

/** How long a `requested` refund is assumed to still be in the middle of its Mercado Pago call. */
export const STALE_REQUESTED_REFUND_MINUTES = 2;

/** Customer-facing status: requested/in_process → pending; approved → completed; failed/rejected → failed. */
export function toCustomerRefundStatus(status: string): CustomerRefundStatus {
  if (status === "approved") return "completed";
  if (status === "failed" || status === "rejected") return "failed";
  return "pending";
}

/**
 * Normalizes a Mercado Pago refund status into the subset stored in
 * `refunds.status`: `approved`, `in_process` (still settling) or `rejected`
 * (any terminal non-approval, e.g. `cancelled`).
 */
export function normalizeProviderRefundStatus(status: string | null | undefined): "approved" | "in_process" | "rejected" {
  if (status === "approved") return "approved";
  if (status === "in_process" || status === "pending" || status === "authorized") return "in_process";
  return "rejected";
}

export type RefundTransition = "accept" | "complete" | "reject" | "ignore";

/**
 * Transition table of `applyRefundStatus`:
 * - `requested` → `approved`/`in_process`: accept (the reason's effect runs);
 * - `in_process` → `approved`: complete;
 * - `requested`/`in_process` → `rejected`: reject;
 * - same status, final statuses (`approved`, `rejected`, `failed`) or anything else: ignore.
 */
export function decideRefundTransition(current: string, next: string): RefundTransition {
  if (current === next) return "ignore";
  if (current === "requested") {
    if (next === "approved" || next === "in_process") return "accept";
    if (next === "rejected") return "reject";
    return "ignore";
  }
  if (current === "in_process") {
    if (next === "approved") return "complete";
    if (next === "rejected") return "reject";
  }
  return "ignore";
}

/** Splits a seat label such as "A12" back into its row and number. */
export function parseSeatLabel(label: string): { rowLabel: string; seatNumber: number } {
  const match = /^(.*?)(\d+)$/.exec(label);
  if (!match) return { rowLabel: label, seatNumber: 0 };
  return { rowLabel: match[1], seatNumber: Number(match[2]) };
}
