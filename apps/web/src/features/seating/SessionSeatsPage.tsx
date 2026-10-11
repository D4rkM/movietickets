import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { holdSeat, releaseAllHolds, releaseSeat } from "./api";
import { SeatMap } from "./SeatMap";
import type { SeatMapSeat } from "./types";

export function SessionSeatsPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const { accessToken, user } = useAuth();
  const navigate = useNavigate();
  const [selectedSeats, setSelectedSeats] = useState<SeatMapSeat[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSeatIds, setPendingSeatIds] = useState<Set<string>>(new Set());

  async function toggleSeat(seat: SeatMapSeat) {
    if (!sessionId || !accessToken || pendingSeatIds.has(seat.id)) return;
    setError(null);
    setPendingSeatIds((current) => new Set(current).add(seat.id));

    const isSelected = selectedSeats.some((selected) => selected.id === seat.id);
    try {
      if (isSelected) {
        await releaseSeat(sessionId, seat.id, accessToken);
        setSelectedSeats((current) => current.filter((selected) => selected.id !== seat.id));
      } else {
        await holdSeat(sessionId, seat.id, accessToken);
        setSelectedSeats((current) => [...current, seat]);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
      setError((err as Error).message);
    } finally {
      setPendingSeatIds((current) => {
        const next = new Set(current);
        next.delete(seat.id);
        return next;
      });
    }
  }

  function goToCheckout() {
    navigate("/checkout", {
      state: { sessionId, seatIds: selectedSeats.map((seat) => seat.id) },
    });
  }

  function confirmCancel() {
    if (sessionId && accessToken) {
      // Best-effort: the hold's TTL frees the seat up anyway even if this call fails.
      releaseAllHolds(sessionId, accessToken).catch(() => {});
    }
    navigate("/movies");
  }

  if (!sessionId || !accessToken || !user) {
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
      {error && (
        <p role="alert" className="mb-4 text-red-600">
          {error}
        </p>
      )}
      <SeatMap
        sessionId={sessionId}
        accessToken={accessToken}
        userId={user.id}
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
