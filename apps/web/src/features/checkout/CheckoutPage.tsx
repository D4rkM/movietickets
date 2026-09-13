import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { bookSeat, confirmBooking, getSeatMap } from "../seating/api";
import type { SeatMapSeat } from "../seating/types";

interface CheckoutLocationState {
  sessionId: string;
  seatIds: string[];
}

function isCheckoutLocationState(state: unknown): state is CheckoutLocationState {
  return (
    typeof state === "object" &&
    state !== null &&
    "sessionId" in state &&
    "seatIds" in state
  );
}

export function CheckoutPage() {
  const { accessToken } = useAuth();
  const location = useLocation();
  const state = isCheckoutLocationState(location.state) ? location.state : null;

  const [seats, setSeats] = useState<SeatMapSeat[] | null>(null);
  const [priceCents, setPriceCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!state || !accessToken) return;
    let cancelled = false;

    getSeatMap(state.sessionId, accessToken)
      .then((seatMap) => {
        if (cancelled) return;
        setPriceCents(seatMap.priceCents);
        setSeats(seatMap.seats.filter((seat) => state.seatIds.includes(seat.id)));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [state, accessToken]);

  async function handlePay() {
    if (!state || !accessToken) return;
    setError(null);
    setPaying(true);
    try {
      // Mocked payment: skip any real gateway, but still confirm each booking so
      // the seat map reflects it as booked (see [Back] Confirmação definitiva do
      // assento no pagamento).
      for (const seatId of state.seatIds) {
        const { bookingId } = await bookSeat(state.sessionId, seatId, accessToken);
        await confirmBooking(bookingId, accessToken);
      }
      setConfirmed(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPaying(false);
    }
  }

  if (!state) {
    return <Navigate to="/movies" replace />;
  }

  if (confirmed) {
    return (
      <main className="mx-auto max-w-md px-4 py-8 text-center">
        <h1 className="text-2xl font-semibold">Ingresso confirmado!</h1>
        <p className="mt-2 text-gray-600">{state.seatIds.length} assento(s) reservado(s) com sucesso.</p>
        <Link to="/movies" className="mt-6 inline-block text-sm underline">
          Voltar ao catálogo
        </Link>
      </main>
    );
  }

  const totalCents = priceCents * state.seatIds.length;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-4 text-2xl font-semibold">Resumo do pedido</h1>

      {!seats && !error && <p>Carregando resumo…</p>}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}

      {seats && (
        <ul className="mb-4 flex flex-col gap-1">
          {seats.map((seat) => (
            <li key={seat.id}>
              Assento {seat.rowLabel}
              {seat.seatNumber}
            </li>
          ))}
        </ul>
      )}

      <p className="mb-6 text-lg font-medium">Total: R$ {(totalCents / 100).toFixed(2)}</p>

      <button
        type="button"
        disabled={paying || !seats}
        onClick={handlePay}
        className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {paying ? "Processando…" : "Pagar (mock)"}
      </button>
    </main>
  );
}
