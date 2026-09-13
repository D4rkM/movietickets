import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { TicketsPage } from "./TicketsPage";

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
});
