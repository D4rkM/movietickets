import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatMap } from "./SeatMap";

describe("SeatMap (integration)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should show a loading state and then the seat map once the request resolves", async () => {
    // GIVEN the API will respond with a seat map after the component mounts
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        room: { rows: 1, seatsPerRow: 1 },
        priceCents: 1000,
        seats: [{ id: "1", rowLabel: "A", seatNumber: 1, status: "free" }],
      }),
    } as Response);

    // WHEN the component mounts
    render(<SeatMap sessionId="session-1" accessToken="token" />);

    // THEN it shows a loading state first, then the seat once the fetch resolves
    expect(screen.getByText("Carregando mapa de assentos…")).toBeInTheDocument();
    expect(await screen.findByTitle("A1 — Disponível")).toBeInTheDocument();
  });

  it("should show an error message when the API request fails", async () => {
    // GIVEN the API returns a non-ok response
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    // WHEN the component mounts
    render(<SeatMap sessionId="missing-session" accessToken="token" />);

    // THEN it shows an error message instead of the seat map
    expect(await screen.findByRole("alert")).toHaveTextContent("404");
  });

  it("should request the seat map for the given session with the token as a bearer header", async () => {
    // GIVEN the API responds successfully
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ room: { rows: 0, seatsPerRow: 0 }, priceCents: 0, seats: [] }),
    } as Response);

    // WHEN the component mounts with a given session and token
    render(<SeatMap sessionId="session-42" accessToken="secret-token" />);
    await screen.findByText(/Preço/);

    // THEN the request targets that session with the token as a bearer header
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/session-42/seats"),
      expect.objectContaining({ headers: { Authorization: "Bearer secret-token" } }),
    );
  });
});
