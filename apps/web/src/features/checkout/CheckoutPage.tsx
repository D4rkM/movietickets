import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { bookSeat, confirmBooking, getSeatMap } from "../seating/api";
import type { SeatMapSeat, TicketType } from "../seating/types";

interface CheckoutLocationState {
  sessionId: string;
  seatIds: string[];
}

interface TicketChoice {
  ticketType: TicketType;
  halfPriceDocument: string;
}

const HALF_PRICE_RATIO = 0.5;

function isCheckoutLocationState(state: unknown): state is CheckoutLocationState {
  return (
    typeof state === "object" &&
    state !== null &&
    "sessionId" in state &&
    "seatIds" in state
  );
}

function priceForChoice(basePriceCents: number, choice: TicketChoice): number {
  return choice.ticketType === "half" ? Math.round(basePriceCents * HALF_PRICE_RATIO) : basePriceCents;
}

export function CheckoutPage() {
  const { accessToken } = useAuth();
  const location = useLocation();
  const state = isCheckoutLocationState(location.state) ? location.state : null;

  const [seats, setSeats] = useState<SeatMapSeat[] | null>(null);
  const [priceCents, setPriceCents] = useState(0);
  const [choices, setChoices] = useState<Record<string, TicketChoice>>({});
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!state || !accessToken) return;
    let cancelled = false;

    getSeatMap(state.sessionId, accessToken)
      .then((seatMap) => {
        if (cancelled) return;
        const selectedSeats = seatMap.seats.filter((seat) => state.seatIds.includes(seat.id));
        setPriceCents(seatMap.priceCents);
        setSeats(selectedSeats);
        setChoices(
          Object.fromEntries(
            selectedSeats.map((seat) => [seat.id, { ticketType: "full", halfPriceDocument: "" }]),
          ),
        );
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          window.location.href = "/login";
          return;
        }
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [state, accessToken]);

  function updateChoice(seatId: string, update: Partial<TicketChoice>) {
    setChoices((current) => ({ ...current, [seatId]: { ...current[seatId], ...update } }));
  }

  const missingDocument = Object.values(choices).some(
    (choice) => choice.ticketType === "half" && choice.halfPriceDocument.trim() === "",
  );

  async function handlePay() {
    if (!state || !accessToken || missingDocument) return;
    setError(null);
    setPaying(true);
    try {
      // Mocked payment: skip any real gateway, but still confirm each booking so
      // the seat map reflects it as booked (see [Back] Confirmação definitiva do
      // assento no pagamento).
      for (const seatId of state.seatIds) {
        const choice = choices[seatId];
        const { bookingId } = await bookSeat(
          state.sessionId,
          seatId,
          accessToken,
          choice.ticketType,
          choice.ticketType === "half" ? choice.halfPriceDocument.trim() : undefined,
        );
        await confirmBooking(bookingId, accessToken);
      }
      setConfirmed(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
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

  const totalCents = seats?.reduce((sum, seat) => sum + priceForChoice(priceCents, choices[seat.id]), 0) ?? 0;

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
        <ul className="mb-4 flex flex-col gap-4">
          {seats.map((seat) => {
            const choice = choices[seat.id];
            return (
              <li key={seat.id} className="rounded border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Assento {seat.rowLabel}
                    {seat.seatNumber}
                  </span>
                  <span className="text-sm text-gray-500">
                    R$ {(priceForChoice(priceCents, choice) / 100).toFixed(2)}
                  </span>
                </div>

                <div className="mt-2 flex gap-4 text-sm">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`ticket-type-${seat.id}`}
                      checked={choice.ticketType === "full"}
                      onChange={() => updateChoice(seat.id, { ticketType: "full" })}
                    />
                    Inteira
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`ticket-type-${seat.id}`}
                      checked={choice.ticketType === "half"}
                      onChange={() => updateChoice(seat.id, { ticketType: "half" })}
                    />
                    Meia
                  </label>
                </div>

                {choice.ticketType === "half" && (
                  <label className="mt-2 flex flex-col gap-1">
                    <span className="text-xs text-gray-500">Documento da meia-entrada</span>
                    <input
                      type="text"
                      value={choice.halfPriceDocument}
                      onChange={(event) =>
                        updateChoice(seat.id, { halfPriceDocument: event.target.value })
                      }
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mb-6 text-lg font-medium">Total: R$ {(totalCents / 100).toFixed(2)}</p>

      <button
        type="button"
        disabled={paying || !seats || missingDocument}
        onClick={handlePay}
        className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {paying ? "Processando…" : "Pagar (mock)"}
      </button>
    </main>
  );
}
