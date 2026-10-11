import { render, screen } from "@testing-library/react";
import { io } from "socket.io-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { SeatMap } from "./SeatMap";

vi.mock("./api");
vi.mock("socket.io-client", () => ({ io: vi.fn() }));

function mockSocket() {
  const handlers: Record<string, (payload?: unknown) => void> = {};
  const socket = {
    on: vi.fn((event: string, cb: (payload?: unknown) => void) => {
      handlers[event] = cb;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  vi.mocked(io).mockReturnValue(socket as never);
  return { socket, handlers };
}

describe("SeatMap (WebSocket live updates)", () => {
  beforeEach(() => {
    vi.mocked(api.getSeatMap).mockResolvedValue({
      room: { rows: 1, seatsPerRow: 2 },
      priceCents: 2000,
      seats: [
        { id: "seat-1", rowLabel: "A", seatNumber: 1, status: "free" },
        { id: "seat-2", rowLabel: "A", seatNumber: 2, status: "free" },
      ],
    });
  });

  it("should join the session's room once connected, and leave it on unmount", () => {
    // GIVEN the socket mock
    const { socket, handlers } = mockSocket();

    // WHEN the component mounts and the socket connects
    const { unmount } = render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    handlers.connect?.();

    // THEN it joins the session room, and leaves + disconnects on unmount
    expect(socket.emit).toHaveBeenCalledWith("join", "session-1");
    unmount();
    expect(socket.emit).toHaveBeenCalledWith("leave", "session-1");
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("should update only the affected seat when a seat:update event arrives", async () => {
    // GIVEN the seat map has loaded
    const { handlers } = mockSocket();
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");

    // WHEN another user's hold event arrives for seat A2
    handlers["seat:update"]?.({ seatId: "seat-2", status: "held", heldByUserId: "other-user" });

    // THEN only A2 changes, A1 stays untouched — no refetch of the whole map
    expect(await screen.findByTitle("A2 — Bloqueado")).toBeInTheDocument();
    expect(screen.getByTitle("A1 — Disponível")).toBeInTheDocument();
    expect(api.getSeatMap).toHaveBeenCalledTimes(1);
  });

  it("should mark a seat as booked when its booked event arrives", async () => {
    // GIVEN the seat map has loaded
    const { handlers } = mockSocket();
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");

    // WHEN the booked event arrives (another user completed checkout)
    handlers["seat:update"]?.({ seatId: "seat-1", status: "booked" });

    // THEN the seat shows as reserved
    expect(await screen.findByTitle("A1 — Reservado")).toBeInTheDocument();
  });

  it("should free a seat up again once its released event arrives", async () => {
    // GIVEN a seat was just held by someone else
    const { handlers } = mockSocket();
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");
    handlers["seat:update"]?.({ seatId: "seat-1", status: "held", heldByUserId: "other-user" });
    await screen.findByTitle("A1 — Bloqueado");

    // WHEN the hold is released (TTL expiry or cancellation)
    handlers["seat:update"]?.({ seatId: "seat-1", status: "released" });

    // THEN it goes back to free
    expect(await screen.findByTitle("A1 — Disponível")).toBeInTheDocument();
  });

  it("should treat a held event as the current user's own selection when the ids match", async () => {
    // GIVEN the seat map has loaded for user-1
    const { handlers } = mockSocket();
    render(<SeatMap sessionId="session-1" accessToken="token" userId="user-1" />);
    await screen.findByTitle("A1 — Disponível");

    // WHEN the echo of this same user's own hold arrives back over the socket
    handlers["seat:update"]?.({ seatId: "seat-1", status: "held", heldByUserId: "user-1" });

    // THEN it shows as selected, not merely blocked
    expect(await screen.findByTitle("A1 — Selecionado")).toBeInTheDocument();
  });
});
