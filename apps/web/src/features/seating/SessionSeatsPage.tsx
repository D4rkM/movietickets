import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { SeatMap } from "./SeatMap";
import type { SeatMapSeat } from "./types";

export function SessionSeatsPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [selectedSeats, setSelectedSeats] = useState<SeatMapSeat[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);

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

  function confirmCancel() {
    // No seat hold exists yet (the Valkey lock is planned but not implemented),
    // so there's nothing to release — just leave the page.
    navigate("/movies");
  }

  if (!sessionId || !accessToken) {
    return null;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <button
        type="button"
        onClick={() => setShowCancelModal(true)}
        className="mb-4 text-sm text-gray-600 underline"
      >
        ← Voltar
      </button>
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

      {showCancelModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 px-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded bg-white p-6">
            <p className="mb-4">Deseja mesmo cancelar a reserva?</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCancelModal(false)}
                className="rounded px-3 py-1.5 text-sm text-gray-600"
              >
                Não
              </button>
              <button
                type="button"
                onClick={confirmCancel}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
              >
                Sim, cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
