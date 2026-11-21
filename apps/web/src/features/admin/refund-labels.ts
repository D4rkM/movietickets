import type { AdminRefundStatus, RefundReviewItem, RefundReviewReason } from "./types";

const REVIEW_REASON_LABELS: Record<RefundReviewReason, string> = {
  expired_booking_paid: "Pagamento aprovado em reserva expirada",
  refund_rejected: "Estorno recusado",
  refund_stalled: "Estorno parado",
};

const REFUND_STATUS_LABELS: Record<AdminRefundStatus, string> = {
  requested: "Solicitado",
  in_process: "Em processamento",
  approved: "Aprovado",
  rejected: "Recusado",
  failed: "Falhou",
};

export function reviewReasonLabel(reason: RefundReviewReason): string {
  return REVIEW_REASON_LABELS[reason] ?? reason;
}

/** pt-BR label for a raw refund status; "—" when the booking has no refund yet. */
export function refundStatusLabel(status: AdminRefundStatus | null | undefined): string {
  if (!status) return "—";
  return REFUND_STATUS_LABELS[status] ?? status;
}

/** An `in_process` refund is reconciled ("Atualizar status") instead of refunded again. */
export function isRefundReconcile(item: RefundReviewItem): boolean {
  return item.refund?.status === "in_process";
}
