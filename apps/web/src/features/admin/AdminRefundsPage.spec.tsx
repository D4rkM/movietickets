import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { ACCESS_TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "../../lib/api-client";
import type { RefundReviewItem } from "./types";

function reviewItem(overrides: Partial<RefundReviewItem> & { bookingId: string }): RefundReviewItem {
  return {
    bookingStatus: "expired",
    customerEmail: "cliente@x.com",
    movieTitle: "Dune",
    sessionStartsAt: "2026-12-20T22:00:00.000Z",
    amountCents: 5000,
    externalPaymentId: "mp-1",
    paymentApprovedAt: "2026-11-20T12:00:00.000Z",
    reviewReason: "expired_booking_paid",
    refund: null,
    ...overrides,
  };
}

const EXPIRED_PAID = reviewItem({ bookingId: "booking-expired", customerEmail: "cliente@x.com", movieTitle: "Dune" });
const REJECTED = reviewItem({
  bookingId: "booking-rejected",
  bookingStatus: "cancelled",
  customerEmail: "outra@x.com",
  movieTitle: "Oppenheimer",
  amountCents: 4000,
  reviewReason: "refund_rejected",
  refund: { id: "refund-1", status: "rejected", errorCode: null, updatedAt: "2026-11-20T12:00:00.000Z" },
});
const STALLED = reviewItem({
  bookingId: "booking-stalled",
  customerEmail: "parado@x.com",
  movieTitle: "Interstellar",
  reviewReason: "refund_stalled",
  refund: { id: "refund-2", status: "requested", errorCode: null, updatedAt: "2026-11-20T12:00:00.000Z" },
});
const IN_PROCESS = reviewItem({
  bookingId: "booking-in-process",
  customerEmail: "processando@x.com",
  movieTitle: "Tenet",
  refund: { id: "refund-3", status: "in_process", errorCode: null, updatedAt: "2026-11-20T12:00:00.000Z" },
});

interface BackendState {
  queue: RefundReviewItem[];
  /** Answers `POST /admin/bookings/:id/refund`; defaults to an approved refund that leaves the queue. */
  refund?: (bookingId: string) => Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function installBackend(state: BackendState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/admin/refunds/review") {
      return json(state.queue);
    }
    const refundMatch = /^\/admin\/bookings\/([^/]+)\/refund$/.exec(url.pathname);
    if (method === "POST" && refundMatch) {
      const bookingId = refundMatch[1];
      if (state.refund) return state.refund(bookingId);
      const item = state.queue.find((candidate) => candidate.bookingId === bookingId)!;
      state.queue = state.queue.filter((candidate) => candidate.bookingId !== bookingId);
      return json({
        bookingId,
        bookingStatus: item.bookingStatus,
        refund: { id: "refund-new", status: "approved", amountCents: item.amountCents },
      });
    }
    return json({ message: "Not Found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function refundCalls(fetchMock: ReturnType<typeof installBackend>) {
  return fetchMock.mock.calls.filter(([input]) => input.toString().endsWith("/refund"));
}

function queueLoads(fetchMock: ReturnType<typeof installBackend>) {
  return fetchMock.mock.calls.filter(([input]) => input.toString().endsWith("/admin/refunds/review"));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function rowFor(email: string) {
  return (await screen.findByRole("cell", { name: email })).closest("tr")!;
}

describe("AdminRefundsPage (integration)", () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "admin-jwt-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "admin-1", name: "Admin", email: "admin@movietickets.dev", role: "admin" }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("AC30: deve listar a fila de estornos com filme, cliente, valor e motivo em pt-BR", async () => {
    // GIVEN the review queue has one booking per review reason
    installBackend({ queue: [EXPIRED_PAID, REJECTED, STALLED] });

    // WHEN the admin opens /admin/refunds
    renderAt("/admin/refunds");

    // THEN each row shows the movie, customer, amount and the pt-BR reason
    const expiredRow = await rowFor("cliente@x.com");
    expect(within(expiredRow).getByText("Dune")).toBeInTheDocument();
    expect(within(expiredRow).getByText("R$ 50,00")).toBeInTheDocument();
    expect(within(expiredRow).getByText("Pagamento aprovado em reserva expirada")).toBeInTheDocument();
    expect(within(expiredRow).getByText("—")).toBeInTheDocument();
    const rejectedRow = await rowFor("outra@x.com");
    expect(within(rejectedRow).getByText("Estorno recusado")).toBeInTheDocument();
    expect(within(rejectedRow).getByText("R$ 40,00")).toBeInTheDocument();
    expect(within(rejectedRow).getByText("Recusado")).toBeInTheDocument();
    const stalledRow = await rowFor("parado@x.com");
    expect(within(stalledRow).getByText("Estorno parado")).toBeInTheDocument();
    expect(within(stalledRow).getByText("Solicitado")).toBeInTheDocument();
    expect(within(stalledRow).getByRole("button", { name: "Estornar" })).toBeInTheDocument();
  });

  it("AC30: deve mostrar mensagem de fila vazia quando nenhuma reserva aguarda estorno", async () => {
    // GIVEN the review queue is empty
    installBackend({ queue: [] });

    // WHEN the admin opens /admin/refunds
    renderAt("/admin/refunds");

    // THEN it says there is nothing to review
    expect(await screen.findByText("Nenhuma reserva aguardando estorno.")).toBeInTheDocument();
  });

  it("AC30: deve pedir confirmação ao clicar em Estornar, chamar a API e recarregar a fila", async () => {
    // GIVEN a queued expired booking and an admin who confirms the dialog
    const fetchMock = installBackend({ queue: [EXPIRED_PAID, REJECTED] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("/admin/refunds");
    const row = await rowFor("cliente@x.com");

    // WHEN the admin clicks "Estornar"
    await userEvent.click(within(row).getByRole("button", { name: "Estornar" }));

    // THEN it asked for confirmation with amount and customer
    expect(confirmSpy).toHaveBeenCalledWith("Estornar R$ 50,00 para cliente@x.com?");
    // AND called the refund endpoint for that booking
    expect(refundCalls(fetchMock)).toHaveLength(1);
    expect(refundCalls(fetchMock)[0][0].toString()).toMatch(/\/admin\/bookings\/booking-expired\/refund$/);
    // AND reloaded the queue, which no longer has the refunded booking
    expect(await screen.findByRole("status")).toHaveTextContent("Estorno de cliente@x.com: Aprovado.");
    expect(screen.queryByRole("cell", { name: "cliente@x.com" })).not.toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "outra@x.com" })).toBeInTheDocument();
    expect(queueLoads(fetchMock)).toHaveLength(2);
  });

  it("AC30: não deve chamar a API quando o admin desiste na confirmação", async () => {
    // GIVEN a queued booking and an admin who dismisses the dialog
    const fetchMock = installBackend({ queue: [EXPIRED_PAID] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAt("/admin/refunds");
    const row = await rowFor("cliente@x.com");

    // WHEN the admin clicks "Estornar" and cancels
    await userEvent.click(within(row).getByRole("button", { name: "Estornar" }));

    // THEN no refund is requested and the row stays
    expect(refundCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("cell", { name: "cliente@x.com" })).toBeInTheDocument();
  });

  it("AC30: deve mostrar Atualizar status para estorno em andamento e reconciliar sem pedir confirmação", async () => {
    // GIVEN a queued booking whose refund is in_process
    const fetchMock = installBackend({ queue: [IN_PROCESS] });
    const confirmSpy = vi.spyOn(window, "confirm");
    renderAt("/admin/refunds");
    const row = await rowFor("processando@x.com");
    expect(within(row).queryByRole("button", { name: "Estornar" })).not.toBeInTheDocument();
    expect(within(row).getByText("Em processamento")).toBeInTheDocument();

    // WHEN the admin clicks "Atualizar status"
    await userEvent.click(within(row).getByRole("button", { name: "Atualizar status" }));

    // THEN the same endpoint is called without a confirmation and the queue is reloaded
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(refundCalls(fetchMock)[0][0].toString()).toMatch(/\/admin\/bookings\/booking-in-process\/refund$/);
    expect(await screen.findByText("Nenhuma reserva aguardando estorno.")).toBeInTheDocument();
  });

  it("AC30: deve mostrar a mensagem do back quando o estorno falha e recarregar a fila", async () => {
    // GIVEN the provider rejects the refund
    const fetchMock = installBackend({
      queue: [EXPIRED_PAID],
      refund: () =>
        json(
          {
            statusCode: 422,
            code: "REFUND_REJECTED",
            message: "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
          },
          422,
        ),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("/admin/refunds");
    const row = await rowFor("cliente@x.com");

    // WHEN the admin clicks "Estornar"
    await userEvent.click(within(row).getByRole("button", { name: "Estornar" }));

    // THEN the backend message is shown and the queue was reloaded
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
    );
    expect(queueLoads(fetchMock)).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "cliente@x.com" })).toBeInTheDocument();
  });

  it("should link to the refunds page from the admin home and navigation", async () => {
    // GIVEN an empty review queue
    installBackend({ queue: [] });

    // WHEN the admin opens the admin home and follows the "Estornos" card
    renderAt("/admin");
    expect(screen.getByRole("navigation", { name: "Navegação admin" })).toHaveTextContent("Estornos");
    await userEvent.click(screen.getByRole("heading", { name: "Estornos" }));

    // THEN the refunds page is shown
    expect(await screen.findByText("Nenhuma reserva aguardando estorno.")).toBeInTheDocument();
  });
});
