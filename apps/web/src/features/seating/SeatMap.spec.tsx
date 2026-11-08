import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { SeatMap } from "./SeatMap";
import type { SeatMapSeat } from "./types";

vi.mock("./api");
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

function makeRectangularSeats(rows: number, seatsPerRow: number): SeatMapSeat[] {
  return Array.from({ length: rows }, (_, rowIndex) => {
    const rowLabel = String.fromCharCode(65 + rowIndex);
    return Array.from({ length: seatsPerRow }, (_, seatIndex) => ({
      id: `${rowLabel}-${seatIndex + 1}`,
      rowLabel,
      seatNumber: seatIndex + 1,
      status: "free" as const,
    }));
  }).flat();
}

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
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);

    // ASSERT
    expect(await screen.findByTitle("A1 — Disponível")).toBeInTheDocument();
    expect(screen.getByTitle("A2 — Bloqueado")).toBeInTheDocument();
    expect(screen.getByTitle("A3 — Selecionado")).toBeInTheDocument();
    expect(screen.getByTitle("A4 — Reservado")).toBeInTheDocument();
  });

  it("should show the session's price converted from cents", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 1, seatsPerRow: 1 },
      priceCents: 3050,
      seats: [{ id: "1", rowLabel: "A", seatNumber: 1, status: "free" }],
    });

    // ACT
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);

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
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");

    // ASSERT
    expect(screen.getByText("Disponível")).toBeInTheDocument();
    expect(screen.getByText("Selecionado")).toBeInTheDocument();
    expect(screen.getByText("Reservado")).toBeInTheDocument();
    expect(screen.getByText("Bloqueado")).toBeInTheDocument();
  });

  it("should render a small rectangular 5x8 room with uniform row structure", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 5, seatsPerRow: 8 },
      priceCents: 2000,
      seats: makeRectangularSeats(5, 8),
    });

    // ACT
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");

    // ASSERT
    expect(screen.getByTitle("E8 — Disponível")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(40);
  });

  it("should render a large rectangular 26x40 room keeping the same aisle layout on every row including Z", async () => {
    // ARRANGE
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 26, seatsPerRow: 40 },
      priceCents: 3500,
      seats: makeRectangularSeats(26, 40),
    });

    // ACT
    const { container } = render(
      <SeatMap sessionId="session-1" accessToken="token" userId="user-1" />,
    );
    await screen.findByTitle("Z40 — Disponível");

    // ASSERT
    expect(screen.getByTitle("A1 — Disponível")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(26 * 40);
    // Every row in a 26x40 rectangular room (including back row Z) gets 2 aisles (52 spacer divs total).
    const aisleSpacers = container.querySelectorAll('div[style*="width"]');
    expect(aisleSpacers).toHaveLength(26 * 2);
  });
});
