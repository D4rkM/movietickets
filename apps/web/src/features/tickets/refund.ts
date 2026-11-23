import type { Ticket, TicketRefundStatus } from "./types";

/** Text shown after the cancellation deadline (2 hours before the session). */
export const CANCELLATION_CLOSED_TEXT = "Cancelamento encerrado (até 2 horas antes da sessão)";

/** Whether the "Cancelar" button applies: confirmed, before the deadline, and no refund already pending. */
export function canCancelTicket(ticket: Ticket, now: Date = new Date()): boolean {
  if (ticket.status !== "confirmed") return false;
  if (ticket.refund?.status === "pending") return false;
  return now.getTime() < new Date(ticket.cancellableUntil).getTime();
}

/** Whether a confirmed ticket is past its cancellation deadline. */
export function isCancellationClosed(ticket: Ticket, now: Date = new Date()): boolean {
  return ticket.status === "confirmed" && now.getTime() >= new Date(ticket.cancellableUntil).getTime();
}

/**
 * Badge text for the booking's last refund. A cancelled booking folds the
 * cancellation into the sentence so the notice reads as one clear line. A failed
 * refund on a booking that is still confirmed means the ticket is still valid
 * (the customer can retry); on a cancelled/expired booking the team reviews it.
 */
export function refundBadgeText(refundStatus: TicketRefundStatus, bookingStatus: string): string {
  const cancelled = bookingStatus === "cancelled";
  if (refundStatus === "pending") return cancelled ? "Ingresso cancelado. Estorno em andamento." : "Estorno em andamento";
  if (refundStatus === "completed") return cancelled ? "Ingresso cancelado e estornado." : "Estorno concluído";
  return bookingStatus === "confirmed"
    ? "Não foi possível estornar. Seu ingresso continua válido."
    : "Não foi possível estornar. Nossa equipe vai analisar.";
}

/** Label for a ticket that is no longer valid. */
export function inactiveTicketLabel(bookingStatus: string): string | null {
  if (bookingStatus === "cancelled") return "Cancelado";
  if (bookingStatus === "expired") return "Expirado";
  return null;
}

/** Whether the ticket content should be dimmed: it is no longer valid (cancelled/expired). */
export function isTicketInactive(bookingStatus: string): boolean {
  return inactiveTicketLabel(bookingStatus) !== null;
}
