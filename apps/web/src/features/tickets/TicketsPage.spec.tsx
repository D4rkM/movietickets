import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { TicketsPage } from "./TicketsPage";

const DUNE_TICKET = {
  bookingId: "booking-1",
  status: "confirmed",
  session: {
    id: "session-1",
    startsAt: "2026-01-01T20:00:00.000Z",
    priceCents: 2500,
    movie: { title: "Dune" },
    room: { name: "Sala 1" },
    cinema: { name: "Cine A", city: "Recife" },
  },
  seats: [{ rowLabel: "A", seatNumber: 1 }],
};

const OPPENHEIMER_TICKET = {
  bookingId: "booking-2",
  status: "confirmed",
  session: {
    id: "session-2",
    startsAt: "2026-01-02T20:00:00.000Z",
    priceCents: 4000,
    movie: { title: "Oppenheimer" },
    room: { name: "Sala 2" },
    cinema: { name: "Cine B", city: "São Paulo" },
  },
  seats: [{ rowLabel: "B", seatNumber: 2 }],
};

function renderTicketsPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <TicketsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
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

  it("should list confirmed tickets with movie, session and seat details", async () => {
    // GIVEN the API returns one confirmed ticket
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          bookingId: "booking-1",
          status: "confirmed",
          session: {
            id: "session-1",
            startsAt: "2026-01-01T20:00:00.000Z",
            priceCents: 2500,
            movie: { title: "Dune" },
            room: { name: "Sala 1" },
            cinema: { name: "Cine A", city: "Recife" },
          },
          seats: [{ rowLabel: "A", seatNumber: 1 }],
        },
      ],
    } as Response);

    // WHEN the page renders
    renderTicketsPage();

    // THEN it shows the ticket details
    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByText(/Assentos: A1/)).toBeInTheDocument();
    expect(screen.getByText("Total: R$ 25.00")).toBeInTheDocument();
  });

  it("should show an empty state when there are no confirmed tickets", async () => {
    // GIVEN the API returns no tickets
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);

    // WHEN the page renders
    renderTicketsPage();

    // THEN it shows the empty state
    expect(await screen.findByText("Você ainda não tem ingressos confirmados.")).toBeInTheDocument();
  });

  describe("cancelling a ticket", () => {
    beforeEach(() => {
      vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const urlString = url.toString();
        if (urlString.includes("/cancel") && init?.method === "POST") {
          return Promise.resolve({ ok: true } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => [DUNE_TICKET, OPPENHEIMER_TICKET] } as Response);
      });
    });

    it("should ask for confirmation before cancelling and keep the ticket when dismissed", async () => {
      // GIVEN both tickets are showing
      renderTicketsPage();
      await screen.findByText("Dune");

      // WHEN the user clicks cancel on Dune's ticket and dismisses the confirmation
      const duneCard = screen.getByText("Dune").closest("li")!;
      await userEvent.click(within(duneCard).getByRole("button", { name: "Cancelar" }));
      expect(screen.getByText(/Deseja mesmo cancelar o ingresso de/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Não" }));

      // THEN the modal closes and both tickets are still there
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("Dune")).toBeInTheDocument();
      expect(screen.getByText("Oppenheimer")).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/cancel"), expect.anything());
    });

    it("should cancel only the targeted ticket and remove it from the list", async () => {
      // GIVEN both tickets are showing
      renderTicketsPage();
      await screen.findByText("Dune");

      // WHEN the user cancels Dune's ticket specifically
      const duneCard = screen.getByText("Dune").closest("li")!;
      await userEvent.click(within(duneCard).getByRole("button", { name: "Cancelar" }));
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN it calls cancel for booking-1, Dune disappears, Oppenheimer stays
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/bookings/booking-1/cancel"),
        expect.objectContaining({ method: "POST" }),
      );
      await screen.findByText("Oppenheimer");
      expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    });

    it("should show an error and keep the ticket in the list when cancellation fails", async () => {
      // GIVEN the cancel request will fail
      vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const urlString = url.toString();
        if (urlString.includes("/cancel") && init?.method === "POST") {
          return Promise.resolve({ ok: false, status: 409 } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => [DUNE_TICKET] } as Response);
      });
      renderTicketsPage();
      await screen.findByText("Dune");

      // WHEN the user tries to cancel
      await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

      // THEN it shows the error and the ticket stays in the list
      expect(await screen.findByRole("alert")).toHaveTextContent(/status 409/);
      expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
    });
  });
});
