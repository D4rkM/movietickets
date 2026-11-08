import type { ReleasedSeat, ReleasedSeatReason } from "../auth/types";
import type { SeatMapSeat } from "./types";

const REASON_LABEL: Record<ReleasedSeatReason, string> = {
  expired: "o tempo de reserva acabou antes do login",
  limit: "liberado para respeitar o limite de 6 assentos por sessão",
};

interface ReleasedSeatsNoticeProps {
  releasedSeats: ReleasedSeat[];
  /** Seats of the current session, used to show "A3" instead of a raw seat id. */
  seats: SeatMapSeat[];
  onDismiss: () => void;
}

export function ReleasedSeatsNotice({ releasedSeats, seats, onDismiss }: ReleasedSeatsNoticeProps) {
  if (releasedSeats.length === 0) return null;

  const labelById = new Map(seats.map((seat) => [seat.id, `${seat.rowLabel}${seat.seatNumber}`]));

  return (
    <div role="status" className="mb-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-medium">Alguns assentos não ficaram com você:</p>
      <ul className="mt-2 list-disc pl-5">
        {releasedSeats.map((seat) => (
          <li key={`${seat.sessionId}:${seat.seatId}`}>
            {labelById.get(seat.seatId) ?? "Assento"}: {REASON_LABEL[seat.reason]}
          </li>
        ))}
      </ul>
      <p className="mt-2">Revise sua seleção antes de continuar.</p>
      <button type="button" onClick={onDismiss} className="mt-2 text-sm underline">
        Entendi
      </button>
    </div>
  );
}
