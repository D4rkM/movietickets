import { useEffect, useState } from "react";
import { getSeatMap } from "./api";
import "./SeatMap.css";
import type { SeatMapResponse, SeatState } from "./types";

interface SeatMapProps {
  sessionId: string;
  accessToken: string;
}

const STATUS_LABEL: Record<SeatState, string> = {
  free: "Livre",
  held_by_other: "Reservado (outra pessoa)",
  held_by_me: "Selecionado por você",
  booked: "Ocupado",
};

export function SeatMap({ sessionId, accessToken }: SeatMapProps) {
  const [seatMap, setSeatMap] = useState<SeatMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSeatMap(sessionId, accessToken)
      .then((data) => {
        if (!cancelled) {
          setSeatMap(data);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, accessToken]);

  if (error) {
    return <p role="alert">Não foi possível carregar o mapa de assentos: {error}</p>;
  }

  if (!seatMap) {
    return <p>Carregando mapa de assentos…</p>;
  }

  return (
    <div className="seat-map">
      <p className="seat-map__price">Preço: R$ {(seatMap.priceCents / 100).toFixed(2)}</p>
      <div
        className="seat-map__grid"
        style={{ gridTemplateColumns: `repeat(${seatMap.room.seatsPerRow}, auto)` }}
      >
        {seatMap.seats.map((seat) => (
          <div
            key={seat.id}
            className={`seat-map__seat seat-map__seat--${seat.status}`}
            title={`${seat.rowLabel}${seat.seatNumber} — ${STATUS_LABEL[seat.status]}`}
          >
            {seat.rowLabel}
            {seat.seatNumber}
          </div>
        ))}
      </div>
      <ul className="seat-map__legend">
        {(Object.keys(STATUS_LABEL) as SeatState[]).map((status) => (
          <li key={status} className={`seat-map__legend-item seat-map__legend-item--${status}`}>
            {STATUS_LABEL[status]}
          </li>
        ))}
      </ul>
    </div>
  );
}
