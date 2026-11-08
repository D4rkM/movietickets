import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { deleteAdminMovie, listAdminMovies } from "./api";
import type { AdminMovie } from "./types";

export function AdminMoviesPage() {
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();
  const [movies, setMovies] = useState<AdminMovie[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    listAdminMovies(accessToken)
      .then((data) => {
        if (!cancelled) {
          setMovies(data);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          logout();
          navigate("/login");
          return;
        }
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, logout, navigate]);

  async function handleDelete(movie: AdminMovie) {
    if (!accessToken) return;
    if (!window.confirm(`Deseja excluir o filme "${movie.title}"?`)) {
      return;
    }

    setError(null);
    try {
      await deleteAdminMovie(movie.id, accessToken);
      setMovies((current) => current?.filter((item) => item.id !== movie.id) ?? null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao excluir o filme");
    }
  }

  return (
    <AdminLayout
      title="Filmes"
      action={
        <Link
          to="/admin/movies/new"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
        >
          Novo filme
        </Link>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {!movies && !error && <p>Carregando filmes…</p>}
      {movies?.length === 0 && <p>Nenhum filme cadastrado.</p>}

      {movies && movies.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-600">
                <th className="py-2 pr-4 font-medium">Título</th>
                <th className="py-2 pr-4 font-medium">Duração</th>
                <th className="py-2 pr-4 font-medium">Classificação</th>
                <th className="py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {movies.map((movie) => (
                <tr key={movie.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{movie.title}</td>
                  <td className="py-2 pr-4">{movie.durationMinutes} min</td>
                  <td className="py-2 pr-4">{movie.rating ?? "—"}</td>
                  <td className="flex gap-3 py-2">
                    <Link
                      to={`/admin/movies/${movie.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      Editar
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDelete(movie)}
                      className="text-red-600 hover:underline"
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
