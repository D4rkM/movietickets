import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "../../lib/api-client";
import { AuthProvider } from "../auth/AuthContext";
import * as adminApi from "./api";
import { AdminSessionFormPage } from "./AdminSessionFormPage";
import { AdminSessionsPage } from "./AdminSessionsPage";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listAdminMovies: vi.fn(),
    listAdminRooms: vi.fn(),
    listAdminSessions: vi.fn(),
    getAdminSession: vi.fn(),
    createAdminSession: vi.fn(),
    updateAdminSession: vi.fn(),
  };
});

const SAMPLE_MOVIES = [
  {
    id: "movie-1",
    title: "Duna: Parte Dois",
    synopsis: "Sinopse",
    durationMinutes: 166,
    posterUrl: null,
    rating: "14",
  },
];

const SAMPLE_ROOMS = [
  {
    id: "room-1",
    name: "Sala IMAX",
    rows: 8,
    seatsPerRow: 10,
    cinemaId: "cinema-1",
    cinemaName: "Cine Paulista",
  },
];

function renderSessionForm(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/admin/sessions" element={<AdminSessionsPage />} />
          <Route path="/admin/sessions/new" element={<AdminSessionFormPage />} />
          <Route path="/admin/sessions/:id" element={<AdminSessionFormPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AdminSessionFormPage (AC24, AC25)", () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "admin-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "u-admin", name: "Admin", email: "admin@test.com", role: "admin" }),
    );
    vi.mocked(adminApi.listAdminMovies).mockResolvedValue(SAMPLE_MOVIES);
    vi.mocked(adminApi.listAdminRooms).mockResolvedValue(SAMPLE_ROOMS);
    vi.mocked(adminApi.listAdminSessions).mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("AC24: deve exibir a mensagem de erro quando a API responde 409 ou 400 e manter os valores preenchidos", async () => {
    // GIVEN o formulário de criação de sessão carregado e a API configurada para recusar com 409
    vi.mocked(adminApi.createAdminSession).mockRejectedValue(
      new Error("Horário conflita com outra sessão na mesma sala"),
    );
    renderSessionForm("/admin/sessions/new");

    const startsAtField = await screen.findByLabelText(/Início \(horário de São Paulo\)/i);
    const priceField = screen.getByLabelText(/Preço \(R\$\)/i);

    // WHEN o admin preenche horário e preço e envia o formulário
    await userEvent.clear(startsAtField);
    await userEvent.type(startsAtField, "2026-12-20T19:00");
    await userEvent.clear(priceField);
    await userEvent.type(priceField, "38.50");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    // THEN o erro da API aparece em tela e os campos digitados continuam preenchidos
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Horário conflita com outra sessão na mesma sala",
    );
    expect(startsAtField).toHaveValue("2026-12-20T19:00");
    expect(priceField).toHaveValue(38.5);
    expect(screen.getByLabelText("Filme")).toHaveValue("movie-1");
    expect(screen.getByLabelText("Sala")).toHaveValue("room-1");
  });

  it("AC25: deve interpretar 2026-12-20T19:00 como America/Sao_Paulo e enviar startsAt 2026-12-20T22:00:00.000Z mesmo com TZ=UTC", async () => {
    // GIVEN o processo rodando com TZ diferente de São Paulo (TZ=UTC)
    vi.stubEnv("TZ", "UTC");
    vi.mocked(adminApi.createAdminSession).mockResolvedValue({
      id: "session-new",
      startsAt: "2026-12-20T22:00:00.000Z",
      endsAt: "2026-12-21T00:46:00.000Z",
      priceCents: 3500,
      movie: { id: "movie-1", title: "Duna: Parte Dois", durationMinutes: 166 },
      room: { id: "room-1", name: "Sala IMAX" },
      cinema: { id: "cinema-1", name: "Cine Paulista" },
    });

    renderSessionForm("/admin/sessions/new");
    const startsAtField = await screen.findByLabelText(/Início \(horário de São Paulo\)/i);
    const priceField = screen.getByLabelText(/Preço \(R\$\)/i);

    // WHEN o admin digita 2026-12-20T19:00 e preço 35.00 e salva
    await userEvent.clear(startsAtField);
    await userEvent.type(startsAtField, "2026-12-20T19:00");
    await userEvent.clear(priceField);
    await userEvent.type(priceField, "35.00");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    // THEN envia startsAt em UTC correspondente a 19:00 de São Paulo (2026-12-20T22:00:00.000Z)
    await waitFor(() => {
      expect(adminApi.createAdminSession).toHaveBeenCalledWith(
        {
          movieId: "movie-1",
          roomId: "room-1",
          startsAt: "2026-12-20T22:00:00.000Z",
          priceCents: 3500,
        },
        "admin-token",
      );
    });
  });

  it("AC25: ao editar sessão gravada em UTC, deve mostrar o horário de America/Sao_Paulo no formulário e na lista mesmo com TZ=UTC", async () => {
    // GIVEN uma sessão gravada em UTC como 2026-12-20T22:00:00.000Z e o processo em TZ=UTC
    vi.stubEnv("TZ", "UTC");
    const savedSession = {
      id: "session-1",
      startsAt: "2026-12-20T22:00:00.000Z",
      endsAt: "2026-12-21T00:46:00.000Z",
      priceCents: 4200,
      movie: { id: "movie-1", title: "Duna: Parte Dois", durationMinutes: 166 },
      room: { id: "room-1", name: "Sala IMAX" },
      cinema: { id: "cinema-1", name: "Cine Paulista" },
    };
    vi.mocked(adminApi.getAdminSession).mockResolvedValue(savedSession);
    vi.mocked(adminApi.listAdminSessions).mockResolvedValue([savedSession]);

    // WHEN o admin abre a página de edição e também a lista de sessões
    const { unmount } = renderSessionForm("/admin/sessions/session-1");

    // THEN o campo datetime-local exibe 2026-12-20T19:00 (horário de São Paulo)
    const startsAtField = await screen.findByLabelText(/Início \(horário de São Paulo\)/i);
    expect(startsAtField).toHaveValue("2026-12-20T19:00");
    expect(screen.getByLabelText(/Preço \(R\$\)/i)).toHaveValue(42);

    unmount();
    renderSessionForm("/admin/sessions");

    // THEN na lista de sessões o horário também aparece como 20/12/2026 19:00
    expect(await screen.findByText("20/12/2026 19:00")).toBeInTheDocument();
  });
});
