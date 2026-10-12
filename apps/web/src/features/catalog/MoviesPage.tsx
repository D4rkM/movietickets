import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ProfileMenu } from "../auth/ProfileMenu";
import { listMovies } from "./api";
import type { CatalogMovie } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

interface CinemaOption {
  id: string;
  name: string;
  city: string;
}

/** Builds the filter dropdown options from the unfiltered catalog — there's no dedicated cinemas endpoint. */
function extractCinemas(movies: CatalogMovie[]): CinemaOption[] {
  const byId = new Map<string, CinemaOption>();
  for (const movie of movies) {
    for (const session of movie.sessions) {
      byId.set(session.cinema.id, session.cinema);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function MoviesPage() {
  const [movies, setMovies] = useState<CatalogMovie[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cinemas, setCinemas] = useState<CinemaOption[]>([]);
  const [city, setCity] = useState("");
  const [cinemaId, setCinemaId] = useState("");
  const [date, setDate] = useState("");

  // Fetched once, unfiltered, purely to populate the city/cinema dropdowns —
  // kept separate from the (possibly filtered) list below.
  useEffect(() => {
    listMovies()
      .then((data) => setCinemas(extractCinemas(data)))
      .catch(() => {
        // Filter options are a nice-to-have; a failure here shouldn't block the page.
      });
  }, []);

  useEffect(() => {
    let cancelled = false;

    listMovies({ city: city || undefined, cinemaId: cinemaId || undefined, date: date || undefined })
      .then((data) => {
        if (cancelled) return;
        setMovies(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [city, cinemaId, date]);

  const cities = useMemo(() => [...new Set(cinemas.map((cinema) => cinema.city))].sort(), [cinemas]);
  const cinemaOptionsForCity = useMemo(
    () => cinemas.filter((cinema) => !city || cinema.city === city),
    [cinemas, city],
  );
  const hasActiveFilters = city !== "" || cinemaId !== "" || date !== "";

  function clearFilters() {
    setCity("");
    setCinemaId("");
    setDate("");
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Em cartaz</h1>
        <ProfileMenu />
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">Cidade</span>
          <select
            value={city}
            onChange={(event) => {
              setCity(event.target.value);
              setCinemaId("");
            }}
            className="rounded border border-gray-300 px-2 py-1.5"
          >
            <option value="">Todas as cidades</option>
            {cities.map((cityOption) => (
              <option key={cityOption} value={cityOption}>
                {cityOption}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">Cinema</span>
          <select
            value={cinemaId}
            onChange={(event) => setCinemaId(event.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5"
          >
            <option value="">Todos os cinemas</option>
            {cinemaOptionsForCity.map((cinema) => (
              <option key={cinema.id} value={cinema.id}>
                {cinema.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">Data</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5"
          />
        </label>

        {hasActiveFilters && (
          <button type="button" onClick={clearFilters} className="text-sm text-gray-600 underline">
            Limpar filtros
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {!movies && !error && <p>Carregando filmes…</p>}
      {movies?.length === 0 && <p>Nenhum filme em cartaz no momento.</p>}

      <ul className="flex flex-col gap-6">
        {movies?.map((movie) => (
          <li key={movie.id} className="rounded border border-gray-200 p-4">
            <h2 className="text-lg font-medium">{movie.title}</h2>
            {movie.synopsis && <p className="mt-1 text-sm text-gray-600">{movie.synopsis}</p>}
            <p className="mt-1 text-sm text-gray-500">{movie.durationMinutes} min</p>

            {movie.sessions.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">Sem sessões disponíveis.</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {movie.sessions.map((session) => (
                  <li key={session.id}>
                    <Link
                      to={`/sessions/${session.id}/seats`}
                      className="block rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                    >
                      <span className="block font-medium">{formatDateTime(session.startsAt)}</span>
                      <span className="block text-gray-500">
                        {session.cinema.name} · {session.room.name} · R${" "}
                        {(session.priceCents / 100).toFixed(2)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
