import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import {
  createAdminSession,
  getAdminSession,
  listAdminMovies,
  listAdminRooms,
  updateAdminSession,
} from "./api";
import {
  centsToReaisInput,
  isoToSaoPauloDateTimeLocal,
  reaisToCents,
  saoPauloDateTimeLocalToIso,
} from "./format";
import type { AdminMovie, AdminRoom } from "./types";

export function AdminSessionFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();

  const [movies, setMovies] = useState<AdminMovie[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [movieId, setMovieId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [startsAtInput, setStartsAtInput] = useState("");
  const [priceReaisInput, setPriceReaisInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    const loadData = async () => {
      try {
        const [movieList, roomList] = await Promise.all([
          listAdminMovies(accessToken),
          listAdminRooms(accessToken),
        ]);
        if (cancelled) return;
        setMovies(movieList);
        setRooms(roomList);

        if (isEdit && id) {
          const session = await getAdminSession(id, accessToken);
          if (cancelled) return;
          setMovieId(session.movie.id);
          setRoomId(session.room.id);
          setStartsAtInput(isoToSaoPauloDateTimeLocal(session.startsAt));
          setPriceReaisInput(centsToReaisInput(session.priceCents));
        } else {
          if (movieList.length > 0) {
            setMovieId((current) => current || movieList[0]!.id);
          }
          if (roomList.length > 0) {
            setRoomId((current) => current || roomList[0]!.id);
          }
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          logout();
          navigate("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Falha ao carregar dados da sessão");
        setLoading(false);
      }
    };

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [accessToken, id, isEdit, logout, navigate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;

    setError(null);
    setSubmitting(true);

    const startsAtIso = saoPauloDateTimeLocalToIso(startsAtInput);
    const priceCents = reaisToCents(priceReaisInput);
    const payload = {
      movieId,
      roomId,
      startsAt: startsAtIso || startsAtInput,
      priceCents: Number.isNaN(priceCents) ? 0 : priceCents,
    };

    try {
      if (isEdit && id) {
        await updateAdminSession(id, payload, accessToken);
      } else {
        await createAdminSession(payload, accessToken);
      }
      navigate("/admin/sessions");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao salvar a sessão");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={isEdit ? "Editar sessão" : "Nova sessão"}>
      {loading ? (
        <p>Carregando sessão…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span>Filme</span>
            <select
              value={movieId}
              onChange={(event) => setMovieId(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Selecione um filme</option>
              {movies.map((movie) => (
                <option key={movie.id} value={movie.id}>
                  {movie.title}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Sala</span>
            <select
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Selecione uma sala</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.cinemaName} — {room.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Início (horário de São Paulo)</span>
            <input
              type="datetime-local"
              value={startsAtInput}
              onChange={(event) => setStartsAtInput(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Preço (R$)</span>
            <input
              type="number"
              step="0.01"
              value={priceReaisInput}
              onChange={(event) => setPriceReaisInput(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
            >
              Salvar
            </button>
            <Link to="/admin/sessions" className="text-sm text-gray-600 hover:underline">
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </AdminLayout>
  );
}
