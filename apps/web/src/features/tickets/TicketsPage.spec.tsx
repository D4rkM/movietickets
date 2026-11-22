import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { TicketsPage } from "./TicketsPage";
import type { Ticket } from "./types";

const HOUR_MS = 60 * 60 * 1000;

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * HOUR_MS).toISOString();
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function buildTicket(overrides: Partial<Ticket> & { title: string; bookingId: string }): Ticket {
  const { title, ...rest } = overrides;
  return {
    status: "confirmed",
    session: {
      id: `session-${overrides.bookingId}`,
      startsAt: hoursFromNow(48),
      priceCents: 2500,
      movie: { title },
      room: { name: "Sala 1" },
      cinema: { name: "Cine A", city: "Recife" },
    },
    seats: [{ rowLabel: "A", seatNumber: 1 }],
    amountCents: 2500,
    cancellableUntil: hoursFromNow(46),
    refund: null,
    ...rest,
  };
}

const DUNE_TICKET = buildTicket({ bookingId: "booking-1", title: "Dune", amountCents: 5000 });
const OPPENHEIMER_TICKET = buildTicket({ bookingId: "booking-2", title: "Oppenheimer", amountCents: 4000 });

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const PENDING_REFUND_RESPONSE = {
  bookingId: "booking-1",
  status: "cancelled",
  refund: { id: "refund-1", status: "pending", amountCents: 5000 },
};

/** Serves `GET /bookings/mine` with `tickets` and answers each cancel call with the next queued response. */
function mockBackend(tickets: Ticket[] | (() => Ticket[]), cancelResponses: Response[] = []) {
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    if (url.toString().includes("/cancel") && init?.method === "POST") {
      const next = cancelResponses.shift();
      return Promise.resolve(next ?? jsonResponse(PENDING_REFUND_RESPONSE));
    }
    return Promise.resolve(jsonResponse(typeof tickets === "function" ? tickets() : tickets));
  });
}

function cancelCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().includes("/cancel"));
}

function renderTicketsPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <TicketsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function openCancelDialogFor(title: string) {
  await screen.findByText(title);
  const card = screen.getByText(title).closest("li")!;
  await userEvent.click(within(card).getByRole("button", { name: "Cancelar" }));
  return screen.getByRole("dialog");
}

describe("TicketsPage (integration)", () => {
  beforeEach(() => {
    localStorage.setItem("movietickets:accessToken", "token-123");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should list confirmed tickets with movie, session, seats and the booking total", async () => {
    // GIVEN the API returns one confirmed ticket with a half-price seat
    mockBackend([
      buildTicket({
        bookingId: "booking-1",
        title: "Dune",
        seats: [
          { rowLabel: "A", seatNumber: 1 },
          { rowLabel: "A", seatNumber: 2 },
        ],
        amountCents: 3750,
      }),
    ]);

    // WHEN the page renders
    renderTicketsPage();

    // THEN it shows the ticket details, with the total coming from amountCents
    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText(/Assentos: A1, A2/)).toBeInTheDocument();
    expect(screen.getByText("Total: R$ 37,50")).toBeInTheDocument();
  });

  it("should show an empty state when there are no tickets", async () => {
    // GIVEN the API returns no tickets
    mockBackend([]);

    // WHEN the page renders
    renderTicketsPage();

    // THEN it shows the empty state
    expect(await screen.findByText("Você ainda não tem ingressos confirmados.")).toBeInTheDocument();
  });

  describe("AC27: cancellation dialog and deadline", () => {
    it("AC27: deve mostrar no diálogo o valor do estorno integral e o prazo de cancelamento", async () => {
      // GIVEN a confirmed R$ 50,00 ticket still inside the cancellation window
      mockBackend([DUNE_TICKET]);
      renderTicketsPage();

      // WHEN the user opens the cancel dialog
      const dialog = await openCancelDialogFor("Dune");

      // THEN it shows the amount, the full refund to the card and the deadline
      expect(dialog).toHaveTextContent("Deseja mesmo cancelar o ingresso de Dune?");
      expect(dialog).toHaveTextContent(
        "Ao cancelar, o valor de R$ 50,00 será estornado integralmente no cartão usado na compra.",
      );
      expect(dialog).toHaveTextContent(
        `Cancelamento permitido até ${formatDateTime(DUNE_TICKET.cancellableUntil)} (2 horas antes da sessão).`,
      );
    });

    it("AC27: não deve mostrar o botão Cancelar depois do prazo e deve avisar que o cancelamento encerrou", async () => {
      // GIVEN a confirmed ticket whose session starts in 1 hour (deadline already passed)
      mockBackend([
        buildTicket({
          bookingId: "booking-1",
          title: "Dune",
          cancellableUntil: hoursFromNow(-1),
        }),
      ]);

      // WHEN the page renders
      renderTicketsPage();

      // THEN there is no cancel button, only the closed-cancellation text
      await screen.findByText("Dune");
      expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
      expect(screen.getByText("Cancelamento encerrado (até 2 horas antes da sessão)")).toBeInTheDocument();
    });
  });

  describe("AC28: cancelling a ticket", () => {
    it("should ask for confirmation before cancelling and keep the ticket when dismissed", async () => {
      // GIVEN both tickets are showing
      mockBackend([DUNE_TICKET, OPPENHEIMER_TICKET]);
      renderTicketsPage();

      // WHEN the user clicks cancel on Dune's ticket and dismisses the confirmation
      await openCancelDialogFor("Dune");
      await userEvent.click(screen.getByRole("button", { name: "Não" }));

      // THEN the modal closes, both tickets are still there and nothing was cancelled
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("Dune")).toBeInTheDocument();
      expect(screen.getByText("Oppenheimer")).toBeInTheDocument();
      expect(cancelCalls()).toHaveLength(0);
    });

    it("AC28: deve manter o ingresso cancelado na lista com o selo de estorno em andamento", async () => {
      // GIVEN both tickets are showing and the refund will be accepted
      mockBackend([DUNE_TICKET, OPPENHEIMER_TICKET], [jsonResponse(PENDING_REFUND_RESPONSE)]);
      renderTicketsPage();

      // WHEN the user cancels Dune's ticket specifically
      await openCancelDialogFor("Dune");
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN it calls cancel for booking-1 only
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/bookings/booking-1/cancel"),
        expect.objectContaining({ method: "POST" }),
      );
      // AND Dune stays listed as cancelled with the pending-refund badge and no cancel button
      const duneCard = (await screen.findByText("Estorno em andamento")).closest("li")!;
      expect(within(duneCard).getByText("Dune")).toBeInTheDocument();
      expect(within(duneCard).getByText("Cancelado")).toBeInTheDocument();
      expect(within(duneCard).queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
      // AND Oppenheimer is untouched
      const oppenheimerCard = screen.getByText("Oppenheimer").closest("li")!;
      expect(within(oppenheimerCard).getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("AC28: deve manter o ingresso como cancelado sem selo quando não havia pagamento a estornar", async () => {
      // GIVEN a ticket confirmed without an approved payment (refund: null on cancel)
      mockBackend([DUNE_TICKET], [jsonResponse({ bookingId: "booking-1", status: "cancelled", refund: null })]);
      renderTicketsPage();

      // WHEN the user cancels it
      await openCancelDialogFor("Dune");
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN the ticket stays listed as cancelled, with no refund badge
      expect(await screen.findByText("Cancelado")).toBeInTheDocument();
      expect(screen.queryByTestId("refund-badge")).not.toBeInTheDocument();
    });

    it("AC28: deve mostrar a mensagem do back quando o estorno é recusado e recarregar o ingresso", async () => {
      // GIVEN the provider will reject the refund (422), after which the ticket comes back with a failed refund
      let refundRejected = false;
      mockBackend(
        () => [refundRejected ? { ...DUNE_TICKET, refund: { status: "failed", amountCents: 5000 } } : DUNE_TICKET],
        [
          jsonResponse(
            {
              statusCode: 422,
              code: "REFUND_REJECTED",
              message: "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
            },
            422,
          ),
        ],
      );
      renderTicketsPage();
      await openCancelDialogFor("Dune");

      // WHEN the user confirms the cancellation
      refundRejected = true;
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN the backend message is shown and the dialog closes
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // AND the reloaded ticket is still valid, with the failure warning next to the cancel button
      expect(
        await screen.findByText("Não foi possível estornar. Seu ingresso continua válido."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
      expect(screen.queryByText("Cancelado")).not.toBeInTheDocument();
    });

    it("AC28: deve mostrar a mensagem do back quando o prazo de cancelamento já passou", async () => {
      // GIVEN the backend answers 409 CANCELLATION_DEADLINE_PASSED
      mockBackend(
        [DUNE_TICKET],
        [
          jsonResponse(
            {
              statusCode: 409,
              code: "CANCELLATION_DEADLINE_PASSED",
              message: "O cancelamento só é permitido até 2 horas antes do início da sessão.",
            },
            409,
          ),
        ],
      );
      renderTicketsPage();

      // WHEN the user tries to cancel
      await openCancelDialogFor("Dune");
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN it shows the backend message and the ticket stays in the list
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "O cancelamento só é permitido até 2 horas antes do início da sessão.",
      );
      expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
    });

    it("AC28: deve mostrar Tentar de novo quando o provedor não responde e reenviar o mesmo cancelamento", async () => {
      // GIVEN the first cancel times out (504) and the retry succeeds
      mockBackend(
        [DUNE_TICKET],
        [
          jsonResponse(
            {
              statusCode: 504,
              code: "REFUND_PROVIDER_TIMEOUT",
              message: "O provedor de pagamento não respondeu a tempo. Tente novamente.",
            },
            504,
          ),
          jsonResponse(PENDING_REFUND_RESPONSE),
        ],
      );
      renderTicketsPage();
      const dialog = await openCancelDialogFor("Dune");

      // WHEN the first attempt times out
      await userEvent.click(within(dialog).getByRole("button", { name: "Sim, cancelar" }));

      // THEN the dialog stays open with the message and a retry button
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "O provedor de pagamento não respondeu a tempo. Tente novamente.",
      );
      const retryButton = within(dialog).getByRole("button", { name: "Tentar de novo" });

      // WHEN the user retries
      await userEvent.click(retryButton);

      // THEN the same endpoint is called again and the ticket shows the pending refund
      expect(await screen.findByText("Estorno em andamento")).toBeInTheDocument();
      const calls = cancelCalls();
      expect(calls).toHaveLength(2);
      expect(calls.every(([url]) => url.toString().endsWith("/bookings/booking-1/cancel"))).toBe(true);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("AC29: refund badge on listed tickets", () => {
    it("AC29: deve mostrar Estorno em andamento para ingresso cancelado com estorno pendente", async () => {
      // GIVEN a cancelled ticket whose refund is still pending
      mockBackend([
        { ...DUNE_TICKET, status: "cancelled", refund: { status: "pending", amountCents: 5000, requestedAt: hoursFromNow(-1) } },
      ]);

      // WHEN the page renders
      renderTicketsPage();

      // THEN it shows the pending badge and no cancel button
      expect(await screen.findByText("Estorno em andamento")).toBeInTheDocument();
      expect(screen.getByText("Cancelado")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    });

    it("AC29: deve mostrar Estorno concluído para ingresso com estorno aprovado", async () => {
      // GIVEN a cancelled ticket whose refund was approved
      mockBackend([
        { ...DUNE_TICKET, status: "cancelled", refund: { status: "completed", amountCents: 5000, requestedAt: hoursFromNow(-1) } },
      ]);

      // WHEN the page renders
      renderTicketsPage();

      // THEN it shows the completed badge
      expect(await screen.findByText("Estorno concluído")).toBeInTheDocument();
    });

    it("AC29: deve mostrar a mensagem de falha para ingresso cancelado com estorno que falhou", async () => {
      // GIVEN a cancelled ticket whose refund failed after being accepted
      mockBackend([
        { ...DUNE_TICKET, status: "cancelled", refund: { status: "failed", amountCents: 5000, requestedAt: hoursFromNow(-1) } },
      ]);

      // WHEN the page renders
      renderTicketsPage();

      // THEN it shows the failure message for the team to review
      expect(await screen.findByText("Não foi possível estornar. Nossa equipe vai analisar.")).toBeInTheDocument();
    });

    it("AC29: deve listar o ingresso expirado com pagamento aprovado e o selo do estorno", async () => {
      // GIVEN an expired booking that was paid and is being refunded
      mockBackend([
        { ...DUNE_TICKET, status: "expired", refund: { status: "pending", amountCents: 5000, requestedAt: hoursFromNow(-1) } },
      ]);

      // WHEN the page renders
      renderTicketsPage();

      // THEN it is labelled as expired with the refund badge
      expect(await screen.findByText("Expirado")).toBeInTheDocument();
      expect(screen.getByText("Estorno em andamento")).toBeInTheDocument();
    });
  });
});
