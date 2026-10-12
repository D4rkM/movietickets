import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { MoviesPage } from "./MoviesPage";

const DUNE = {
  id: "movie-1",
  title: "Dune",
  synopsis: null,
  durationMinutes: 155,
  posterUrl: null,
  rating: null,
  sessions: [
    {
      id: "session-1",
      startsAt: "2026-01-01T20:00:00.000Z",
      priceCents: 3000,
      room: { id: "room-1", name: "Sala 1" },
      cinema: { id: "cinema-1", name: "Cine Recife", city: "Recife" },
    },
  ],
};

const OPPENHEIMER = {
  id: "movie-2",
  title: "Oppenheimer",
  synopsis: null,
  durationMinutes: 180,
  posterUrl: null,
  rating: null,
  sessions: [
    {
      id: "session-2",
      startsAt: "2026-01-02T20:00:00.000Z",
      priceCents: 4000,
      room: { id: "room-2", name: "Sala 2" },
      cinema: { id: "cinema-2", name: "Cine SP", city: "São Paulo" },
    },
  ],
};

function renderMoviesPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MoviesPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("MoviesPage (integration)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should list movies with their upcoming sessions as links to the seat map", async () => {
    // GIVEN the catalog API returns one movie with one session
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "movie-1",
          title: "Dune",
          synopsis: "Sci-fi epic",
          durationMinutes: 155,
          posterUrl: null,
          rating: null,
          sessions: [
            {
              id: "session-1",
              startsAt: "2026-01-01T20:00:00.000Z",
              priceCents: 3000,
              room: { id: "room-1", name: "Sala 1" },
              cinema: { id: "cinema-1", name: "Cine A", city: "Recife" },
            },
          ],
        },
      ],
    } as Response);

    // WHEN the page renders
    renderMoviesPage();

    // THEN it shows the movie and a link to that session's seat map
    expect(await screen.findByText("Dune")).toBeInTheDocument();
    const sessionLink = screen.getByRole("link", { name: /Cine A/ });
    expect(sessionLink).toHaveAttribute("href", "/sessions/session-1/seats");
  });

  it("should show a message when there are no movies in the catalog", async () => {
    // GIVEN the catalog API returns no movies
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);

    // WHEN the page renders
    renderMoviesPage();

    // THEN it shows an empty state
    expect(await screen.findByText("Nenhum filme em cartaz no momento.")).toBeInTheDocument();
  });

  describe("filters", () => {
    beforeEach(() => {
      vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
        const urlString = url.toString();
        const params = new URL(urlString).searchParams;
        const city = params.get("city");
        if (city === "Recife") {
          return Promise.resolve({ ok: true, json: async () => [DUNE] } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => [DUNE, OPPENHEIMER] } as Response);
      });
    });

    it("should populate the city and cinema dropdowns from the unfiltered catalog", async () => {
      // GIVEN the catalog has movies showing in two different cities
      renderMoviesPage();
      await screen.findByText("Dune");
      await screen.findByText("Oppenheimer");

      // THEN both cities and both cinemas show up as filter options
      expect(screen.getByRole("option", { name: "Recife" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "São Paulo" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Cine Recife" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Cine SP" })).toBeInTheDocument();
    });

    it("should refetch the catalog filtered by the selected city", async () => {
      // GIVEN both movies are showing
      renderMoviesPage();
      await screen.findByText("Oppenheimer");

      // WHEN the user filters by Recife
      await userEvent.selectOptions(screen.getByLabelText("Cidade"), "Recife");

      // THEN only the movie with a Recife session remains
      await screen.findByText("Dune");
      expect(screen.queryByText("Oppenheimer")).not.toBeInTheDocument();
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("city=Recife"));
    });

    it("should reset the cinema selection when the city changes", async () => {
      // GIVEN the user already picked a cinema
      renderMoviesPage();
      await screen.findByText("Oppenheimer");
      await userEvent.selectOptions(screen.getByLabelText("Cinema"), "cinema-2");
      expect(screen.getByLabelText("Cinema")).toHaveValue("cinema-2");

      // WHEN the user then changes the city
      await userEvent.selectOptions(screen.getByLabelText("Cidade"), "Recife");

      // THEN the cinema choice resets back to "all"
      expect(screen.getByLabelText("Cinema")).toHaveValue("");
    });

    it("should show 'Limpar filtros' only once a filter is active, and clear every filter when clicked", async () => {
      // GIVEN no filters are set yet
      renderMoviesPage();
      await screen.findByText("Oppenheimer");
      expect(screen.queryByRole("button", { name: "Limpar filtros" })).not.toBeInTheDocument();

      // WHEN the user filters by city
      await userEvent.selectOptions(screen.getByLabelText("Cidade"), "Recife");
      await screen.findByText("Dune");
      expect(screen.queryByText("Oppenheimer")).not.toBeInTheDocument();

      // AND clicks "Limpar filtros"
      await userEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));

      // THEN the filter resets and the full catalog shows again
      expect(screen.getByLabelText("Cidade")).toHaveValue("");
      await screen.findByText("Oppenheimer");
      expect(screen.queryByRole("button", { name: "Limpar filtros" })).not.toBeInTheDocument();
    });
  });
});
