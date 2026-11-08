import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_TOKEN_STORAGE_KEY, storeGuestToken } from "../../lib/guest-token";
import { AuthProvider } from "./AuthContext";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";
import type { LoginResponse } from "./types";

const USER = { id: "user-1", name: "Ana", email: "ana@test.com", role: "customer" };

function LocationProbe({ label }: { label: string }) {
  const location = useLocation();
  return (
    <p>
      {label} {location.search} {JSON.stringify(location.state)}
    </p>
  );
}

function renderLoginAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/movies" element={<LocationProbe label="Movies page" />} />
          <Route path="/sessions/:id/seats" element={<LocationProbe label="Seats page" />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function stubLoginResponse(response: Partial<LoginResponse> = {}) {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ accessToken: "user-token", user: USER, ...response }),
  } as Response);
}

async function submitLogin() {
  await userEvent.type(screen.getByLabelText("E-mail"), "ana@test.com");
  await userEvent.type(screen.getByLabelText("Senha"), "password123");
  await userEvent.click(screen.getByRole("button", { name: "Entrar" }));
}

function sentLoginBody(): Record<string, unknown> {
  const [, init] = vi.mocked(fetch).mock.calls[0];
  return JSON.parse(init!.body as string);
}

describe("LoginPage with a guest hand-over", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("AC5: should send the stored guest token with the credentials and delete it after login", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: "guest-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    stubLoginResponse({ transfer: { keptSeats: [], releasedSeats: [] } });
    renderLoginAt("/login?returnTo=/sessions/session-1/seats");

    // ACT
    await submitLogin();

    // ASSERT
    expect(await screen.findByText(/Seats page/)).toBeInTheDocument();
    expect(sentLoginBody()).toEqual({ email: "ana@test.com", password: "password123", guestToken: "guest-token" });
    expect(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("should not send guestToken when no guest token is stored", async () => {
    // ARRANGE
    stubLoginResponse();
    renderLoginAt("/login");

    // ACT
    await submitLogin();

    // ASSERT
    expect(await screen.findByText(/Movies page/)).toBeInTheDocument();
    expect(sentLoginBody()).toEqual({ email: "ana@test.com", password: "password123" });
  });

  it("should keep the guest token when the login fails", async () => {
    // ARRANGE
    storeGuestToken({ guestToken: "guest-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);
    renderLoginAt("/login?returnTo=/sessions/session-1/seats");

    // ACT
    await submitLogin();

    // ASSERT
    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail ou senha inválidos");
    expect(localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)).not.toBeNull();
  });

  it.each([
    ["/sessions/session-1/seats", /Seats page/],
    ["//evil.example", /Movies page/],
    ["https://evil.example", /Movies page/],
  ])("AC9: should redirect returnTo=%s to the validated destination", async (returnTo, expectedPage) => {
    // ARRANGE
    stubLoginResponse();
    renderLoginAt(`/login?returnTo=${encodeURIComponent(returnTo)}`);

    // ACT
    await submitLogin();

    // ASSERT
    expect(await screen.findByText(expectedPage)).toBeInTheDocument();
  });

  it("AC7: should hand the released seats to the seat page it returns to", async () => {
    // ARRANGE
    const releasedSeats = [{ sessionId: "session-1", seatId: "seat-2", reason: "expired" }];
    stubLoginResponse({
      transfer: { keptSeats: [{ sessionId: "session-1", seatId: "seat-1" }], releasedSeats } as LoginResponse["transfer"],
    });
    renderLoginAt("/login?returnTo=/sessions/session-1/seats");

    // ACT
    await submitLogin();

    // ASSERT
    expect(await screen.findByText(/Seats page/)).toHaveTextContent(JSON.stringify({ releasedSeats }));
  });

  it("should carry returnTo through the register page and back to login", async () => {
    // ARRANGE
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => USER } as Response);
    renderLoginAt("/login?returnTo=/sessions/session-1/seats");

    // ACT
    await userEvent.click(screen.getByRole("link", { name: "Criar conta" }));
    await userEvent.type(screen.getByLabelText("Nome"), "Ana");
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@test.com");
    await userEvent.type(screen.getByLabelText("Senha", { selector: "input" }), "password123");
    await userEvent.type(screen.getByLabelText("Confirmar senha"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));

    // ASSERT
    expect(await screen.findByText("Conta criada! Entra com seu e-mail e senha.")).toBeInTheDocument();
    stubLoginResponse();
    await submitLogin();
    expect(await screen.findByText(/Seats page/)).toBeInTheDocument();
  });
});
