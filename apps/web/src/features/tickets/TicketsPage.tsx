import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { getMyTickets } from "./api";
import type { Ticket } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function TicketsPage() {
  const { accessToken } = useAuth();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Meus ingressos</h1>
        <Link to="/movies" className="text-sm underline">
          Voltar ao catálogo
        </Link>
      </div>

      {error && (
        <p role="alert" className="text-red-600">
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
          </li>
        ))}
      </ul>
    </main>
  );
}
