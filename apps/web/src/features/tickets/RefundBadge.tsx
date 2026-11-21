import { refundBadgeText } from "./refund";
import type { TicketRefund } from "./types";

const BADGE_STYLES: Record<TicketRefund["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

interface RefundBadgeProps {
  refund: TicketRefund;
  bookingStatus: string;
}

export function RefundBadge({ refund, bookingStatus }: RefundBadgeProps) {
  return (
    <span
      data-testid="refund-badge"
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[refund.status]}`}
    >
      {refundBadgeText(refund.status, bookingStatus)}
    </span>
  );
}
