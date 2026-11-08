import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { createAdminRoom, getAdminRoom, listAdminCinemas, updateAdminRoom } from "./api";
import type { AdminCinema } from "./types";

export function AdminRoomFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();

  const [cinemas, setCinemas] = useState<AdminCinema[]>([]);
  const [cinemaId, setCinemaId] = useState("");
  const [name, setName] = useState("");
  const [rows, setRows] = useState("");
  const [seatsPerRow, setSeatsPerRow] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    const loadData = async () => {
      try {
        const cinemaList = await listAdminCinemas(accessToken);
        if (cancelled) return;
        setCinemas(cinemaList);

        if (isEdit && id) {
          const room = await getAdminRoom(id, accessToken);
          if (cancelled) return;
          setCinemaId(room.cinemaId);
          setName(room.name);
          setRows(String(room.rows));
          setSeatsPerRow(String(room.seatsPerRow));
        } else if (cinemaList.length > 0) {
          setCinemaId((current) => current || cinemaList[0]!.id);
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          logout();
          navigate("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Falha ao carregar dados da sala");
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

    try {
      if (isEdit && id) {
        await updateAdminRoom(
          id,
          {
            name,
            rows: Number(rows),
            seatsPerRow: Number(seatsPerRow),
          },
          accessToken,
        );
      } else {
        await createAdminRoom(
          {
            cinemaId,
            name,
            rows: Number(rows),
            seatsPerRow: Number(seatsPerRow),
          },
          accessToken,
        );
      }
      navigate("/admin/rooms");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao salvar a sala");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={isEdit ? "Editar sala" : "Nova sala"}>
      {loading ? (
        <p>Carregando sala…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span>Cinema</span>
            <select
              value={cinemaId}
              disabled={isEdit}
              onChange={(event) => setCinemaId(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100"
            >
              <option value="">Selecione um cinema</option>
              {cinemas.map((cinema) => (
                <option key={cinema.id} value={cinema.id}>
                  {cinema.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Nome</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Fileiras</span>
            <input
              type="number"
              value={rows}
              onChange={(event) => setRows(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Assentos por fileira</span>
            <input
              type="number"
              value={seatsPerRow}
              onChange={(event) => setSeatsPerRow(event.target.value)}
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
            <Link to="/admin/rooms" className="text-sm text-gray-600 hover:underline">
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </AdminLayout>
  );
}
