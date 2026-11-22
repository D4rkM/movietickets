import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { formatCentsBRL } from "../../lib/money";
import { useAuth } from "../auth/AuthContext";
import { CancelBookingError, cancelBooking, getMyTickets } from "./api";
import { RefundBadge } from "./RefundBadge";
import { CANCELLATION_CLOSED_TEXT, canCancelTicket, inactiveTicketLabel, isCancellationClosed } from "./refund";
import type { CancelBookingResult, Ticket } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** Applies a successful cancel response to the ticket, keeping it listed as cancelled with its refund. */
function applyCancellation(ticket: Ticket, result: CancelBookingResult): Ticket {
  return {
    ...ticket,
    status: result.status,
    refund: result.refund ? { status: result.refund.status, amountCents: result.refund.amountCents } : null,
  };
}

export function TicketsPage() {
  const { accessToken } = useAuth();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Ticket | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const loadTickets = useCallback(
    (isCancelled: () => boolean = () => false) => {
      if (!accessToken) return;
      getMyTickets(accessToken)
        .then((data) => {
          if (!isCancelled()) setTickets(data);
        })
        .catch((err: Error) => {
          if (isCancelled()) return;
          if (err instanceof UnauthorizedError) {
            window.location.href = "/login";
            return;
          }
          setError(err.message);
        });
    },
    [accessToken],
  );

  useEffect(() => {
    let cancelled = false;
    loadTickets(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTickets]);

  function openCancelDialog(ticket: Ticket) {
    setError(null);
    setDialogError(null);
    setCanRetry(false);
    setCancelTarget(ticket);
  }

  function closeCancelDialog() {
    setCancelTarget(null);
    setDialogError(null);
    setCanRetry(false);
  }

  async function confirmCancel() {
    if (!cancelTarget || !accessToken) return;
    const target = cancelTarget;
    setError(null);
    setDialogError(null);
    setCancelling(true);
    try {
      const result = await cancelBooking(target.bookingId, accessToken);
      setTickets(
        (current) =>
          current?.map((ticket) => (ticket.bookingId === target.bookingId ? applyCancellation(ticket, result) : ticket)) ??
          null,
      );
      closeCancelDialog();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
      if (err instanceof CancelBookingError && err.retryable) {
        // No definitive answer: keep the dialog open so the same request can be replayed.
        setDialogError(err.message);
        setCanRetry(true);
        return;
      }
      closeCancelDialog();
      setError((err as Error).message);
      // A rejected/failed refund is recorded by the backend: reload so the ticket shows it.
      loadTickets();
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
        {tickets?.map((ticket) => {
          const inactiveLabel = inactiveTicketLabel(ticket.status);
          return (
            <li key={ticket.bookingId} className="rounded border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">{ticket.session.movie.title}</h2>
                {inactiveLabel && (
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                    {inactiveLabel}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500">
                {formatDateTime(ticket.session.startsAt)} · {ticket.session.cinema.name} ·{" "}
                {ticket.session.room.name}
              </p>
              <p className="mt-2 text-sm">
                Assentos:{" "}
                {ticket.seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(", ")}
              </p>
              <p className="mt-1 text-sm text-gray-500">Total: {formatCentsBRL(ticket.amountCents)}</p>
              {ticket.refund && (
                <div className="mt-2">
                  <RefundBadge refund={ticket.refund} bookingStatus={ticket.status} />
                </div>
              )}
              {canCancelTicket(ticket) && (
                <button
                  type="button"
                  onClick={() => openCancelDialog(ticket)}
                  className="mt-3 text-sm text-red-600 underline"
                >
                  Cancelar
                </button>
              )}
              {isCancellationClosed(ticket) && (
                <p className="mt-3 text-sm text-gray-500">{CANCELLATION_CLOSED_TEXT}</p>
              )}
            </li>
          );
        })}
      </ul>

      {cancelTarget && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 px-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded bg-white p-6">
            <p className="mb-2">
              Deseja mesmo cancelar o ingresso de <strong>{cancelTarget.session.movie.title}</strong>?
            </p>
            <p className="mb-4 text-sm text-gray-600">
              Ao cancelar, o valor de {formatCentsBRL(cancelTarget.amountCents)} será estornado integralmente no
              cartão usado na compra. O estorno aparece na fatura conforme o prazo do seu banco. Cancelamento
              permitido até {formatDateTime(cancelTarget.cancellableUntil)} (2 horas antes da sessão).
            </p>
            {dialogError && (
              <p role="alert" className="mb-4 text-sm text-red-600">
                {dialogError}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeCancelDialog}
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
                {cancelling ? "Cancelando…" : canRetry ? "Tentar de novo" : "Sim, cancelar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
