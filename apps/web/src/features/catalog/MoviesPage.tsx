import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { listMovies } from "./api";
import type { CatalogMovie } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function MoviesPage() {
  const { logout } = useAuth();
  const [movies, setMovies] = useState<CatalogMovie[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    listMovies()
      .then((data) => {
        if (!cancelled) setMovies(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Em cartaz</h1>
        <button onClick={logout} className="text-sm text-gray-600 underline">
          Sair
        </button>
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
