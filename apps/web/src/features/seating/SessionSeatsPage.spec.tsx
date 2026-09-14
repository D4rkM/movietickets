import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { SessionSeatsPage } from "./SessionSeatsPage";

function renderSessionSeatsPage() {
  return render(
    <MemoryRouter initialEntries={["/sessions/session-1/seats"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sessions/:id/seats" element={<SessionSeatsPage />} />
          <Route path="/checkout" element={<p>Checkout page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("SessionSeatsPage (integration)", () => {
  beforeEach(() => {
    localStorage.setItem("movietickets:accessToken", "token-123");
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        room: { rows: 1, seatsPerRow: 2 },
        priceCents: 2000,
        seats: [
          { id: "seat-1", rowLabel: "A", seatNumber: 1, status: "free" },
          { id: "seat-2", rowLabel: "A", seatNumber: 2, status: "booked" },
        ],
      }),
    } as Response);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should disable the pay button until at least one free seat is selected", async () => {
    // GIVEN the seat map has loaded
    renderSessionSeatsPage();
    await screen.findByTitle("A1 — Disponível");

    // WHEN no seat has been selected yet
    // THEN the pay button is disabled
    expect(screen.getByRole("button", { name: /Pagar/ })).toBeDisabled();
  });

  it("should not allow selecting an already booked seat", async () => {
    // GIVEN the seat map has loaded
    renderSessionSeatsPage();
    const bookedSeat = await screen.findByTitle("A2 — Reservado");

    // WHEN the user clicks the booked seat
    await userEvent.click(bookedSeat);

    // THEN it stays disabled and the pay button remains disabled
    expect(bookedSeat).toBeDisabled();
    expect(screen.getByRole("button", { name: /Pagar/ })).toBeDisabled();
  });

  it("should navigate to /checkout with the selected seat once the user clicks pay", async () => {
    // GIVEN a free seat has been selected
    renderSessionSeatsPage();
    const freeSeat = await screen.findByTitle("A1 — Disponível");
    await userEvent.click(freeSeat);

    // WHEN the user clicks the pay button
    await userEvent.click(screen.getByRole("button", { name: /Pagar \(1 assento\)/ }));

    // THEN it navigates to the checkout page
    expect(await screen.findByText("Checkout page")).toBeInTheDocument();
  });
});
