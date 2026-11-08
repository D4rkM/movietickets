import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { createAdminMovie, getAdminMovie, updateAdminMovie } from "./api";
import { MOVIE_RATINGS } from "./types";

export function AdminMovieFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [rating, setRating] = useState("");
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id || !accessToken) return;
    let cancelled = false;

    getAdminMovie(id, accessToken)
      .then((movie) => {
        if (cancelled) return;
        setTitle(movie.title);
        setSynopsis(movie.synopsis ?? "");
        setDurationMinutes(String(movie.durationMinutes));
        setPosterUrl(movie.posterUrl ?? "");
        setRating(movie.rating ?? "");
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          logout();
          navigate("/login");
          return;
        }
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, id, isEdit, logout, navigate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;

    setError(null);
    setSubmitting(true);

    const payload = {
      title,
      synopsis: synopsis.trim() ? synopsis.trim() : null,
      durationMinutes: Number(durationMinutes),
      posterUrl: posterUrl.trim() ? posterUrl.trim() : null,
      rating: rating ? rating : null,
    };

    try {
      if (isEdit && id) {
        await updateAdminMovie(id, payload, accessToken);
      } else {
        await createAdminMovie(payload, accessToken);
      }
      navigate("/admin/movies");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao salvar o filme");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={isEdit ? "Editar filme" : "Novo filme"}>
      {loading ? (
        <p>Carregando filme…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span>Título</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Sinopse</span>
            <textarea
              value={synopsis}
              onChange={(event) => setSynopsis(event.target.value)}
              rows={3}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Duração (min)</span>
            <input
              type="number"
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>URL do pôster</span>
            <input
              type="text"
              value={posterUrl}
              onChange={(event) => setPosterUrl(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Classificação indicativa</span>
            <select
              value={rating}
              onChange={(event) => setRating(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Sem classificação</option>
              {MOVIE_RATINGS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
            >
              Salvar
            </button>
            <Link to="/admin/movies" className="text-sm text-gray-600 hover:underline">
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </AdminLayout>
  );
}
