import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { cancelBooking, getMyTickets } from "./api";
import type { Ticket } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function TicketsPage() {
  const { accessToken } = useAuth();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Ticket | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    getMyTickets(accessToken)
      .then((data) => {
        if (!cancelled) setTickets(data);
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
  }, [accessToken]);

  async function confirmCancel() {
    if (!cancelTarget || !accessToken) return;
    setError(null);
    setCancelling(true);
    try {
      await cancelBooking(cancelTarget.bookingId, accessToken);
      setTickets((current) => current?.filter((ticket) => ticket.bookingId !== cancelTarget.bookingId) ?? null);
      setCancelTarget(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
      setError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Meus ingressos</h1>
        <Link to="/movies" className="text-sm underline">
          Voltar ao catálogo
        </Link>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-red-600">
          {error}
        </p>
      )}
      {!tickets && !error && <p>Carregando ingressos…</p>}
      {tickets?.length === 0 && <p>Você ainda não tem ingressos confirmados.</p>}

      <ul className="flex flex-col gap-4">
        {tickets?.map((ticket) => (
          <li key={ticket.bookingId} className="rounded border border-gray-200 p-4">
            <h2 className="text-lg font-medium">{ticket.session.movie.title}</h2>
            <p className="text-sm text-gray-500">
              {formatDateTime(ticket.session.startsAt)} · {ticket.session.cinema.name} ·{" "}
              {ticket.session.room.name}
            </p>
            <p className="mt-2 text-sm">
              Assentos:{" "}
              {ticket.seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(", ")}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              Total: R$ {((ticket.session.priceCents * ticket.seats.length) / 100).toFixed(2)}
            </p>
            <button
              type="button"
              onClick={() => setCancelTarget(ticket)}
              className="mt-3 text-sm text-red-600 underline"
            >
              Cancelar
            </button>
          </li>
        ))}
      </ul>

      {cancelTarget && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 px-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded bg-white p-6">
            <p className="mb-4">
              Deseja mesmo cancelar o ingresso de <strong>{cancelTarget.session.movie.title}</strong>?
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                disabled={cancelling}
                className="rounded px-3 py-1.5 text-sm text-gray-600 disabled:opacity-50"
              >
                Não
              </button>
              <button
                type="button"
                onClick={confirmCancel}
                disabled={cancelling}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {cancelling ? "Cancelando…" : "Sim, cancelar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
