import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { ACCESS_TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "../../lib/api-client";
import type { AdminCinema, AdminMovie, AdminRoom, AdminSession } from "./types";

interface InMemoryBackendState {
  cinemas: AdminCinema[];
  movies: AdminMovie[];
  rooms: AdminRoom[];
  sessions: AdminSession[];
}

function createInMemoryFetch(state: InMemoryBackendState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && url.pathname === "/admin/cinemas") {
      return new Response(JSON.stringify(state.cinemas), { status: 200 });
    }

    if (method === "GET" && url.pathname === "/admin/movies") {
      return new Response(JSON.stringify(state.movies), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/admin/movies") {
      const created: AdminMovie = {
        id: `movie-${state.movies.length + 1}`,
        title: body.title,
        synopsis: body.synopsis ?? null,
        durationMinutes: body.durationMinutes,
        posterUrl: body.posterUrl ?? null,
        rating: body.rating ?? null,
      };
      state.movies.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }

    if (method === "GET" && url.pathname === "/admin/rooms") {
      return new Response(JSON.stringify(state.rooms), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/admin/rooms") {
      const cinema = state.cinemas.find((c) => c.id === body.cinemaId)!;
      const created: AdminRoom = {
        id: `room-${state.rooms.length + 1}`,
        name: body.name,
        rows: body.rows,
        seatsPerRow: body.seatsPerRow,
        cinemaId: cinema.id,
        cinemaName: cinema.name,
      };
      state.rooms.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }

    if (method === "GET" && url.pathname === "/admin/sessions") {
      return new Response(JSON.stringify(state.sessions), { status: 200 });
    }

    if (method === "POST" && url.pathname === "/admin/sessions") {
      const movie = state.movies.find((m) => m.id === body.movieId)!;
      const room = state.rooms.find((r) => r.id === body.roomId)!;
      const cinema = state.cinemas.find((c) => c.id === room.cinemaId)!;
      const startsAtDate = new Date(body.startsAt);
      const endsAtDate = new Date(startsAtDate.getTime() + movie.durationMinutes * 60_000);
      const created: AdminSession = {
        id: `session-${state.sessions.length + 1}`,
        startsAt: startsAtDate.toISOString(),
        endsAt: endsAtDate.toISOString(),
        priceCents: body.priceCents,
        movie: { id: movie.id, title: movie.title, durationMinutes: movie.durationMinutes },
        room: { id: room.id, name: room.name },
        cinema: { id: cinema.id, name: cinema.name },
      };
      state.sessions.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }

    if (method === "GET" && url.pathname === "/movies") {
      const catalog = state.movies.map((movie) => ({
        id: movie.id,
        title: movie.title,
        synopsis: movie.synopsis,
        durationMinutes: movie.durationMinutes,
        posterUrl: movie.posterUrl,
        rating: movie.rating,
        sessions: state.sessions
          .filter((session) => session.movie.id === movie.id)
          .map((session) => ({
            id: session.id,
            startsAt: session.startsAt,
            priceCents: session.priceCents,
            room: session.room,
            cinema: {
              id: session.cinema.id,
              name: session.cinema.name,
              city: state.cinemas.find((c) => c.id === session.cinema.id)?.city ?? "São Paulo",
            },
          })),
      }));
      return new Response(JSON.stringify(catalog), { status: 200 });
    }

    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  });
}

describe("Painel Admin — fluxo completo (AC23)", () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "admin-jwt-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({
        id: "admin-1",
        name: "Admin Movietickets",
        email: "admin@movietickets.dev",
        role: "admin",
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("AC23: deve permitir ao admin cadastrar filme, sala e sessão pelos formulários e ver a sessão criada em /movies", async () => {
    // GIVEN um admin autenticado com um cinema disponível
    const state: InMemoryBackendState = {
      cinemas: [
        {
          id: "cinema-1",
          name: "Cine Jardins",
          address: "Av. Paulista, 1000",
          city: "São Paulo",
        },
      ],
      movies: [],
      rooms: [],
      sessions: [],
    };
    vi.stubGlobal("fetch", createInMemoryFetch(state));

    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <App />
      </MemoryRouter>,
    );

    // WHEN o admin navega para Filmes e cadastra um novo filme pelo formulário
    await userEvent.click(await screen.findByRole("link", { name: /^Filmes$/i }));
    await userEvent.click(await screen.findByRole("link", { name: "Novo filme" }));
    await userEvent.type(screen.getByLabelText("Título"), "Interestelar");
    await userEvent.type(screen.getByLabelText("Sinopse"), "Viagem além da galáxia");
    await userEvent.type(screen.getByLabelText("Duração (min)"), "169");
    await userEvent.selectOptions(screen.getByLabelText("Classificação indicativa"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Interestelar")).toBeInTheDocument();

    // AND navega para Salas e cadastra uma nova sala pelo formulário
    await userEvent.click(screen.getByRole("link", { name: "Salas" }));
    await userEvent.click(await screen.findByRole("link", { name: "Nova sala" }));
    const nameInput = await screen.findByLabelText("Nome");
    await userEvent.type(nameInput, "Sala VIP 1");
    await userEvent.type(screen.getByLabelText("Fileiras"), "6");
    await userEvent.type(screen.getByLabelText("Assentos por fileira"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Sala VIP 1")).toBeInTheDocument();

    // AND navega para Sessões e cadastra uma nova sessão para o filme e sala criados
    await userEvent.click(screen.getByRole("link", { name: "Sessões" }));
    await userEvent.click(await screen.findByRole("link", { name: "Nova sessão" }));
    const startsAtInput = await screen.findByLabelText(/Início \(horário de São Paulo\)/i);
    await userEvent.type(startsAtInput, "2026-12-20T19:00");
    await userEvent.type(screen.getByLabelText(/Preço \(R\$\)/i), "45.00");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("20/12/2026 19:00")).toBeInTheDocument();

    // AND abre o catálogo público /movies
    await userEvent.click(screen.getByRole("link", { name: "Catálogo" }));

    // THEN o filme e a sessão recém-criada aparecem em /movies
    expect(await screen.findByRole("heading", { name: "Em cartaz" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Interestelar" })).toBeInTheDocument();
    expect(screen.getByText(/Cine Jardins · Sala VIP 1 · R\$ 45\.00/)).toBeInTheDocument();
  });
});
