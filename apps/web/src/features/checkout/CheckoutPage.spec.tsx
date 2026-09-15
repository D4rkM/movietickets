import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { CheckoutPage } from "./CheckoutPage";

function renderCheckoutPage(locationState: unknown) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: "/checkout", state: locationState }]}
    >
      <AuthProvider>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/movies" element={<p>Movies page</p>} />
          <Route path="/sessions/:id/seats" element={<p>Seat selection page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("CheckoutPage (integration)", () => {
  beforeEach(() => {
    localStorage.setItem("movietickets:accessToken", "token-123");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("should redirect to /movies when there is no checkout state", async () => {
    // GIVEN the page is reached without going through seat selection
    renderCheckoutPage(null);

    // WHEN it renders
    // THEN it redirects to the movies page
    expect(await screen.findByText("Movies page")).toBeInTheDocument();
  });

  it("should ask for confirmation before cancelling and stay on the page when dismissed", async () => {
    // GIVEN the order summary has loaded
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        room: { rows: 1, seatsPerRow: 1 },
        priceCents: 2500,
        seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
      }),
    } as Response);
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });
    await screen.findByText("Assento A1");

    // WHEN the user clicks back and then dismisses the confirmation
    await userEvent.click(screen.getByRole("button", { name: "← Voltar" }));
    expect(screen.getByText("Deseja mesmo cancelar a reserva?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Não" }));

    // THEN the modal closes and the user stays on the checkout page
    expect(screen.queryByText("Deseja mesmo cancelar a reserva?")).not.toBeInTheDocument();
    expect(screen.getByText("Resumo do pedido")).toBeInTheDocument();
  });

  it("should cancel and go back to the catalog when the user confirms, without booking anything", async () => {
    // GIVEN the order summary has loaded
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        room: { rows: 1, seatsPerRow: 1 },
        priceCents: 2500,
        seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
      }),
    } as Response);
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });
    await screen.findByText("Assento A1");

    // WHEN the user clicks back and confirms the cancellation
    await userEvent.click(screen.getByRole("button", { name: "← Voltar" }));
    await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

    // THEN it navigates to the catalog, with no booking request ever made
    expect(await screen.findByText("Movies page")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/book"), expect.anything());
  });

  it("should show the order summary and confirm booking after a mocked payment", async () => {
    // GIVEN a session with one selected seat
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.endsWith("/sessions/session-1/book")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ bookingId: "booking-1", seatId: "seat-1", priceCents: 2500 }],
        } as Response);
      }
      if (urlString.includes("/bookings/") && urlString.includes("/confirm")) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          room: { rows: 1, seatsPerRow: 1 },
          priceCents: 2500,
          seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
        }),
      } as Response);
    });
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });

    // WHEN the summary loads and the user confirms the mocked payment (default: full price)
    expect(await screen.findByText("Assento A1")).toBeInTheDocument();
    expect(screen.getByText("Total: R$ 25.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Pagar$/ }));

    // THEN it books the seat with a full ticket in one request, confirms payment once, and shows the confirmation
    expect(await screen.findByText("Ingresso confirmado!")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/session-1/book"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ seats: [{ seatId: "seat-1", ticketType: "full", halfPriceDocument: undefined }] }),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/bookings/booking-1/confirm"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenCalledTimes(3); // seat map + book + confirm, no per-seat looping
  });

  it("should halve the price and require a document when the user picks 'Meia'", async () => {
    // GIVEN a session with one selected seat
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.endsWith("/sessions/session-1/book")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ bookingId: "booking-1", seatId: "seat-1", priceCents: 1250 }],
        } as Response);
      }
      if (urlString.includes("/bookings/") && urlString.includes("/confirm")) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          room: { rows: 1, seatsPerRow: 1 },
          priceCents: 2500,
          seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
        }),
      } as Response);
    });
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });
    await screen.findByText("Assento A1");

    // WHEN the user picks "Meia" without filling the document
    await userEvent.click(screen.getByRole("radio", { name: "Meia" }));

    // THEN the price halves and the pay button is disabled until a document is entered
    expect(screen.getByText("Total: R$ 12.50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Pagar$/ })).toBeDisabled();

    // WHEN the user fills the document and pays
    await userEvent.type(screen.getByLabelText("Documento da meia-entrada"), "1234567890");
    await userEvent.click(screen.getByRole("button", { name: /^Pagar$/ }));

    // THEN it books the seat as a half ticket with the document, in the single batch request
    expect(await screen.findByText("Ingresso confirmado!")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/session-1/book"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ seats: [{ seatId: "seat-1", ticketType: "half", halfPriceDocument: "1234567890" }] }),
      }),
    );
  });

  it("should redirect to /login when the payment gets a 401 (expired token)", async () => {
    // GIVEN the seat map summary loads fine, but the token expires before paying
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.endsWith("/sessions/session-1/book")) {
        return Promise.resolve({ ok: false, status: 401 } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          room: { rows: 1, seatsPerRow: 1 },
          priceCents: 2500,
          seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
        }),
      } as Response);
    });
    const originalLocation = window.location;
    // @ts-expect-error -- replacing location with a mock to observe the redirect
    delete window.location;
    // @ts-expect-error -- partial Location mock is enough to observe href
    window.location = { ...originalLocation, href: "" };
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });

    // WHEN the user tries to pay
    await screen.findByText("Assento A1");
    await userEvent.click(screen.getByRole("button", { name: /^Pagar$/ }));

    // THEN it clears the stale token and redirects to the login page
    await vi.waitFor(() => expect(window.location.href).toBe("/login"));
    expect(localStorage.getItem("movietickets:accessToken")).toBeNull();

    // @ts-expect-error -- restoring the original Location object
    window.location = originalLocation;
  });

  it("should show an error and never call confirm when the atomic booking request fails", async () => {
    // GIVEN a seat that's already taken (backend rolls back and returns 409)
    const confirmCalls: string[] = [];
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.endsWith("/sessions/session-1/book")) {
        return Promise.resolve({ ok: false, status: 409 } as Response);
      }
      if (urlString.includes("/confirm")) {
        confirmCalls.push(urlString);
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          room: { rows: 1, seatsPerRow: 1 },
          priceCents: 2500,
          seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
        }),
      } as Response);
    });
    renderCheckoutPage({ sessionId: "session-1", seatIds: ["seat-1"] });
    await screen.findByText("Assento A1");

    // WHEN the user tries to pay
    await userEvent.click(screen.getByRole("button", { name: /^Pagar$/ }));

    // THEN it shows the error, never reaches the confirm step, and the pay button is usable again
    expect(await screen.findByRole("alert")).toHaveTextContent(/status 409/);
    expect(confirmCalls).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Pagar$/ })).toBeEnabled();
  });
});
