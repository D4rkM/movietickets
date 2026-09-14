import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { MoviesPage } from "./MoviesPage";

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
});
