import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { SeatMap } from "./SeatMap";
import type { SeatMapSeat } from "./types";

export function SessionSeatsPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [selectedSeats, setSelectedSeats] = useState<SeatMapSeat[]>([]);

  function toggleSeat(seat: SeatMapSeat) {
    setSelectedSeats((current) =>
      current.some((selected) => selected.id === seat.id)
        ? current.filter((selected) => selected.id !== seat.id)
        : [...current, seat],
    );
  }

  function goToCheckout() {
    navigate("/checkout", {
      state: { sessionId, seatIds: selectedSeats.map((seat) => seat.id) },
    });
  }

  if (!sessionId || !accessToken) {
    return null;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link to="/movies" className="mb-4 inline-block text-sm text-gray-600 underline">
        ← Voltar ao catálogo
      </Link>
      <h1 className="mb-4 text-2xl font-semibold">Escolha seus assentos</h1>
      <SeatMap
        sessionId={sessionId}
        accessToken={accessToken}
        selectedSeatIds={selectedSeats.map((seat) => seat.id)}
        onToggleSeat={toggleSeat}
      />
      <button
        type="button"
        disabled={selectedSeats.length === 0}
        onClick={goToCheckout}
        className="mt-6 rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
      >
        Pagar ({selectedSeats.length} assento{selectedSeats.length === 1 ? "" : "s"})
      </button>
    </main>
  );
}
