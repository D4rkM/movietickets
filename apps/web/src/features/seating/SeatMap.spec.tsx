import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { SeatMap } from "./SeatMap";

vi.mock("./api");

describe("SeatMap", () => {
  it("should render each seat with a title reflecting its status", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 1, seatsPerRow: 4 },
      priceCents: 2500,
      seats: [
        { id: "1", rowLabel: "A", seatNumber: 1, status: "free" },
        { id: "2", rowLabel: "A", seatNumber: 2, status: "held_by_other" },
        { id: "3", rowLabel: "A", seatNumber: 3, status: "held_by_me" },
        { id: "4", rowLabel: "A", seatNumber: 4, status: "booked" },
      ],
    });

    // ACT
    render(<SeatMap sessionId="session-1" accessToken="token" />);

    // ASSERT
    expect(await screen.findByTitle("A1 — Livre")).toBeInTheDocument();
    expect(screen.getByTitle("A2 — Reservado (outra pessoa)")).toBeInTheDocument();
    expect(screen.getByTitle("A3 — Selecionado por você")).toBeInTheDocument();
    expect(screen.getByTitle("A4 — Ocupado")).toBeInTheDocument();
  });

  it("should show the session's price converted from cents", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 1, seatsPerRow: 1 },
      priceCents: 3050,
      seats: [{ id: "1", rowLabel: "A", seatNumber: 1, status: "free" }],
    });

    // ACT
    render(<SeatMap sessionId="session-1" accessToken="token" />);

    // ASSERT
    expect(await screen.findByText("Preço: R$ 30.50")).toBeInTheDocument();
  });

  it("should render the legend with all four seat states", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 1, seatsPerRow: 1 },
      priceCents: 1000,
      seats: [{ id: "1", rowLabel: "A", seatNumber: 1, status: "free" }],
    });

    // ACT
    render(<SeatMap sessionId="session-1" accessToken="token" />);
    await screen.findByTitle("A1 — Livre");

    // ASSERT
    expect(screen.getByText("Livre")).toBeInTheDocument();
    expect(screen.getByText("Reservado (outra pessoa)")).toBeInTheDocument();
    expect(screen.getByText("Selecionado por você")).toBeInTheDocument();
    expect(screen.getByText("Ocupado")).toBeInTheDocument();
  });
});
