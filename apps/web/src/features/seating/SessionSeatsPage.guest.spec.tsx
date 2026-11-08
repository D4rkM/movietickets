import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { io } from "socket.io-client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "../../lib/api-client";
import { GUEST_TOKEN_STORAGE_KEY, storeGuestToken } from "../../lib/guest-token";
import { AuthProvider } from "../auth/AuthContext";
import type { ReleasedSeat } from "../auth/types";
import type { SeatMapSeat } from "./types";
import { SessionSeatsPage } from "./SessionSeatsPage";

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

function fakeJwt(sub: string): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode({ kind: "guest", sub })}.signature`;
}

const ISSUED_GUEST_TOKEN = fakeJwt("guest:issued");
const STORED_GUEST_TOKEN = fakeJwt("guest:stored");
const IN_ONE_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

const FREE_SEATS: SeatMapSeat[] = [
  { id: "seat-1", rowLabel: "A", seatNumber: 1, status: "free" },
  { id: "seat-2", rowLabel: "A", seatNumber: 2, status: "free" },
];

function LoginProbe() {
  const location = useLocation();
  return <p>Login page {location.search}</p>;
}

function renderSeatsPage(state: unknown = null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/sessions/session-1/seats", state }]}>
      <AuthProvider>
        <Routes>
          <Route path="/sessions/:id/seats" element={<SessionSeatsPage />} />
          <Route path="/login" element={<LoginProbe />} />
          <Route path="/checkout" element={<p>Checkout page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

interface FakeApiOptions {
  guestStatus?: number;
  seats?: SeatMapSeat[];
}

/** Routes fetch by URL; returns the list of "METHOD path" calls in order. */
function stubApi({ guestStatus = 200, seats = FREE_SEATS }: FakeApiOptions = {}): string[] {
  const calls: string[] = [];
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url.toString()).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/auth/guest") {
      return Promise.resolve({
        ok: guestStatus === 200,
        status: guestStatus,
        json: async () => ({ guestToken: ISSUED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() }),
      } as Response);
    }
    if (path.endsWith("/hold")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ seatId: "seat-1", status: "held", expiresInSeconds: 600 }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ room: { rows: 1, seatsPerRow: seats.length }, priceCents: 2000, seats }),
    } as Response);
  });
  return calls;
}

function authHeaderOf(path: string): string | null {
  const call = vi.mocked(fetch).mock.calls.find(([url]) => new URL(url.toString()).pathname === path);
  return new Headers(call?.[1]?.headers).get("Authorization");
}

describe("SessionSeatsPage as a visitor", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.mocked(io).mockClear();
  });

  it("AC15: should obtain a guest token before reading the seat map and use it for the map and the WebSocket", async () => {
    // ARRANGE
    const calls = stubApi();

    // ACT
    renderSeatsPage();
    await screen.findByTitle("A1 — Disponível");

    // ASSERT
    expect(calls.slice(0, 2)).toEqual(["POST /auth/guest", "GET /sessions/session-1/seats"]);
    expect(authHeaderOf("/sessions/session-1/seats")).toBe(`Bearer ${ISSUED_GUEST_TOKEN}`);
    expect(vi.mocked(io)).toHaveBeenCalledWith(
      expect.stringContaining("/seating"),
      expect.objectContaining({ auth: { token: ISSUED_GUEST_TOKEN } }),
    );
    expect(JSON.parse(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)!).guestToken).toBe(ISSUED_GUEST_TOKEN);
  });

  it("AC15: should reuse a still-valid stored guest token without calling POST /auth/guest", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() });
    const calls = stubApi();

    // ACT
    renderSeatsPage();
    await screen.findByTitle("A1 — Disponível");

    // ASSERT
    expect(calls).not.toContain("POST /auth/guest");
    expect(authHeaderOf("/sessions/session-1/seats")).toBe(`Bearer ${STORED_GUEST_TOKEN}`);
  });

  it("AC15: should request a new guest token when the stored one has expired", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const calls = stubApi();

    // ACT
    renderSeatsPage();
    await screen.findByTitle("A1 — Disponível");

    // ASSERT
    expect(calls[0]).toBe("POST /auth/guest");
    expect(authHeaderOf("/sessions/session-1/seats")).toBe(`Bearer ${ISSUED_GUEST_TOKEN}`);
  });

  it("AC16: should show an error with a retry button and no seat map when POST /auth/guest fails", async () => {
    // ARRANGE
    const calls = stubApi({ guestStatus: 500 });

    // ACT
    renderSeatsPage();

    // ASSERT
    expect(await screen.findByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível abrir o mapa de assentos");
    expect(screen.queryByTitle("A1 — Disponível")).not.toBeInTheDocument();
    expect(calls).not.toContain("GET /sessions/session-1/seats");
  });

  it("AC16: should load the seat map once retrying POST /auth/guest succeeds", async () => {
    // ARRANGE
    stubApi({ guestStatus: 500 });
    renderSeatsPage();
    const retryButton = await screen.findByRole("button", { name: "Tentar de novo" });
    stubApi();

    // ACT
    await userEvent.click(retryButton);

    // ASSERT
    expect(await screen.findByTitle("A1 — Disponível")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).not.toBeInTheDocument();
  });

  it("should drop a guest token the API rejects and continue under a fresh one", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() });
    const calls = stubApi();
    const routeByUrl = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => {
      const rejected = new Headers(init?.headers).get("Authorization") === `Bearer ${STORED_GUEST_TOKEN}`;
      if (rejected) {
        calls.push("401");
        return Promise.resolve({ ok: false, status: 401 } as Response);
      }
      return routeByUrl(url, init);
    });

    // ACT
    renderSeatsPage();

    // ASSERT
    expect(await screen.findByTitle("A1 — Disponível")).toBeInTheDocument();
    expect(calls).toEqual(["401", "POST /auth/guest", "GET /sessions/session-1/seats"]);
    expect(JSON.parse(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)!).guestToken).toBe(ISSUED_GUEST_TOKEN);
  });

  it("should hold a seat with the guest token", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() });
    stubApi();
    renderSeatsPage();

    // ACT
    await userEvent.click(await screen.findByTitle("A1 — Disponível"));

    // ASSERT
    expect(await screen.findByTitle("A1 — Selecionado")).toBeInTheDocument();
    expect(authHeaderOf("/sessions/session-1/seats/seat-1/hold")).toBe(`Bearer ${STORED_GUEST_TOKEN}`);
  });

  it("AC5: should send a visitor to /login with returnTo pointing back to the seat page on continue", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() });
    stubApi();
    renderSeatsPage();
    await userEvent.click(await screen.findByTitle("A1 — Disponível"));
    await screen.findByTitle("A1 — Selecionado");

    // ACT
    await userEvent.click(screen.getByRole("button", { name: /Continuar \(1 assento\)/ }));

    // ASSERT
    expect(await screen.findByText("Login page ?returnTo=/sessions/session-1/seats")).toBeInTheDocument();
    expect(screen.queryByText("Checkout page")).not.toBeInTheDocument();
  });

  it("should restore seats the server reports as held_by_me as the selection", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: STORED_GUEST_TOKEN, expiresAt: IN_ONE_HOUR() });
    stubApi({
      seats: [
        { id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" },
        { id: "seat-2", rowLabel: "A", seatNumber: 2, status: "free" },
      ],
    });

    // ACT
    renderSeatsPage();

    // ASSERT
    expect(await screen.findByTitle("A1 — Selecionado")).toBeEnabled();
    expect(screen.getByRole("button", { name: /Continuar \(1 assento\)/ })).toBeEnabled();
  });
});

describe("SessionSeatsPage after a login that transferred guest holds", () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "user-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "user-1", name: "Ana", email: "ana@test.com", role: "customer" }),
    );
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const SEATS_AFTER_LOGIN: SeatMapSeat[] = [
    { id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" },
    { id: "seat-2", rowLabel: "A", seatNumber: 2, status: "free" },
    { id: "seat-3", rowLabel: "B", seatNumber: 4, status: "free" },
  ];

  it("AC7: should list seats whose guest hold expired, keep them out of the selection and stay on the seat page", async () => {
    // ARRANGE
    stubApi({ seats: SEATS_AFTER_LOGIN });
    const releasedSeats: ReleasedSeat[] = [{ sessionId: "session-1", seatId: "seat-2", reason: "expired" }];

    // ACT
    renderSeatsPage({ releasedSeats });

    // ASSERT
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("A2: o tempo de reserva acabou antes do login");
    expect(await screen.findByTitle("A1 — Selecionado")).toBeInTheDocument();
    expect(screen.getByTitle("A2 — Disponível")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continuar \(1 assento\)/ })).toBeEnabled();
    expect(screen.getByText("Escolha seus assentos")).toBeInTheDocument();
  });

  it("AC7: should drop a released seat from the selection even if the map still reports it as held_by_me", async () => {
    // ARRANGE
    stubApi({ seats: SEATS_AFTER_LOGIN });
    const releasedSeats: ReleasedSeat[] = [{ sessionId: "session-1", seatId: "seat-1", reason: "expired" }];

    // ACT
    renderSeatsPage({ releasedSeats });

    // ASSERT
    expect(await screen.findByRole("status")).toHaveTextContent("A1");
    expect(screen.getByRole("button", { name: /Continuar \(0 assentos\)/ })).toBeDisabled();
  });

  it("AC13: should list seats released to respect the 6-seat limit", async () => {
    // ARRANGE
    stubApi({ seats: SEATS_AFTER_LOGIN });
    const releasedSeats: ReleasedSeat[] = [{ sessionId: "session-1", seatId: "seat-3", reason: "limit" }];

    // ACT
    renderSeatsPage({ releasedSeats });

    // ASSERT
    expect(await screen.findByRole("status")).toHaveTextContent(
      "B4: liberado para respeitar o limite de 6 assentos por sessão",
    );
  });

  it("should ignore released seats from other sessions and hide the notice once dismissed", async () => {
    // ARRANGE
    stubApi({ seats: SEATS_AFTER_LOGIN });
    const releasedSeats: ReleasedSeat[] = [
      { sessionId: "session-1", seatId: "seat-2", reason: "expired" },
      { sessionId: "other-session", seatId: "seat-9", reason: "expired" },
    ];
    renderSeatsPage({ releasedSeats });
    const notice = await screen.findByRole("status");
    await screen.findByTitle("A1 — Selecionado");

    // ACT
    const items = notice.querySelectorAll("li");
    await userEvent.click(screen.getByRole("button", { name: "Entendi" }));

    // ASSERT
    expect(items).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("should use the user token, never asking for a guest token", async () => {
    // ARRANGE
    const calls = stubApi({ seats: SEATS_AFTER_LOGIN });

    // ACT
    renderSeatsPage();
    await screen.findByTitle("A1 — Selecionado");

    // ASSERT
    expect(calls).not.toContain("POST /auth/guest");
    expect(authHeaderOf("/sessions/session-1/seats")).toBe("Bearer user-token");
  });
});
