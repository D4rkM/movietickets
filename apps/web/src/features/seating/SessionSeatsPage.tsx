import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import type { ReleasedSeat } from "../auth/types";
import { holdSeat, releaseAllHolds, releaseSeat } from "./api";
import { readReleasedSeatsState } from "./released-seats-state";
import { ReleasedSeatsNotice } from "./ReleasedSeatsNotice";
import { SeatMap } from "./SeatMap";
import type { SeatMapSeat } from "./types";
import { useSeatingCredentials } from "./useSeatingCredentials";

export function SessionSeatsPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const credentials = useSeatingCredentials();
  const [selectedSeats, setSelectedSeats] = useState<SeatMapSeat[]>([]);
  const [loadedSeats, setLoadedSeats] = useState<SeatMapSeat[]>([]);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSeatIds, setPendingSeatIds] = useState<Set<string>>(new Set());
  // Seats lost when guest holds were handed over at login (AC7/AC13), for this session only.
  const [releasedSeats, setReleasedSeats] = useState<ReleasedSeat[]>(() =>
    readReleasedSeatsState(location.state).filter((seat) => seat.sessionId === sessionId),
  );

  // The notice is a one-off: drop it from the history entry so a reload doesn't
  // show it again. Once cleared, `location.state` is null and this is a no-op.
  useEffect(() => {
    if (location.state) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.state, location.pathname, location.search, navigate]);

  const token = credentials.status === "ready" ? credentials.token : null;
  const isGuest = credentials.status === "ready" && credentials.isGuest;
  const invalidateGuest = credentials.status === "ready" ? credentials.invalidateGuest : undefined;

  const handleUnauthorized = useCallback(() => {
    if (isGuest) {
      // Guest token rejected (e.g. expired mid-visit): get a fresh guest identity.
      invalidateGuest?.();
      return;
    }
    window.location.href = "/login";
  }, [isGuest, invalidateGuest]);

  // Holds are real (Valkey), so the selection is whatever the server says is
  // held by this owner — that's how it survives a reload or the login round-trip.
  const handleSeatMapLoaded = useCallback(
    (seats: SeatMapSeat[]) => {
      const releasedIds = new Set(releasedSeats.map((seat) => seat.seatId));
      setLoadedSeats(seats);
      setSelectedSeats(seats.filter((seat) => seat.status === "held_by_me" && !releasedIds.has(seat.id)));
    },
    [releasedSeats],
  );

  async function toggleSeat(seat: SeatMapSeat) {
    if (!sessionId || !token || pendingSeatIds.has(seat.id)) return;
    setError(null);
    setPendingSeatIds((current) => new Set(current).add(seat.id));

    const isSelected = selectedSeats.some((selected) => selected.id === seat.id);
    try {
      if (isSelected) {
        await releaseSeat(sessionId, seat.id, token);
        setSelectedSeats((current) => current.filter((selected) => selected.id !== seat.id));
      } else {
        await holdSeat(sessionId, seat.id, token);
        setSelectedSeats((current) => [...current, seat]);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
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
    if (isGuest) {
      // Paying needs a user account. The guest's holds stay put and are
      // transferred to the user at login, then the user comes back here.
      navigate(`/login?returnTo=/sessions/${sessionId}/seats`);
      return;
    }
    navigate("/checkout", {
      state: { sessionId, seatIds: selectedSeats.map((seat) => seat.id) },
    });
  }

  function confirmCancel() {
    if (sessionId && token) {
      // Best-effort: the hold's TTL frees the seat up anyway even if this call fails.
      releaseAllHolds(sessionId, token).catch(() => {});
    }
    navigate("/movies");
  }

  if (!sessionId) {
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
      <ReleasedSeatsNotice
        releasedSeats={releasedSeats}
        seats={loadedSeats}
        onDismiss={() => setReleasedSeats([])}
      />
      {error && (
        <p role="alert" className="mb-4 text-red-600">
          {error}
        </p>
      )}
      {credentials.status === "loading" && <p>Preparando o mapa de assentos…</p>}
      {credentials.status === "error" && (
        <div role="alert" className="mb-4 text-red-600">
          <p>Não foi possível abrir o mapa de assentos: {credentials.message}</p>
          <button
            type="button"
            onClick={credentials.retry}
            className="mt-2 rounded border border-red-600 px-3 py-1.5 text-sm"
          >
            Tentar de novo
          </button>
        </div>
      )}
      {credentials.status === "ready" && (
        <SeatMap
          // Remount on identity change, so the map and socket restart under the new token.
          key={credentials.token}
          sessionId={sessionId}
          accessToken={credentials.token}
          userId={credentials.ownerId}
          selectedSeatIds={selectedSeats.map((seat) => seat.id)}
          onToggleSeat={toggleSeat}
          onLoaded={handleSeatMapLoaded}
          onUnauthorized={handleUnauthorized}
        />
      )}
      <button
        type="button"
        disabled={selectedSeats.length === 0}
        onClick={goToCheckout}
        className="mt-6 rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
      >
        Continuar ({selectedSeats.length} assento{selectedSeats.length === 1 ? "" : "s"})
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
