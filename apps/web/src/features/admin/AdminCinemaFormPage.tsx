import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { createAdminCinema, getAdminCinema, updateAdminCinema } from "./api";

export function AdminCinemaFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id || !accessToken) return;
    let cancelled = false;

    getAdminCinema(id, accessToken)
      .then((cinema) => {
        if (cancelled) return;
        setName(cinema.name);
        setAddress(cinema.address);
        setCity(cinema.city);
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

    try {
      if (isEdit && id) {
        await updateAdminCinema(id, { name, address, city }, accessToken);
      } else {
        await createAdminCinema({ name, address, city }, accessToken);
      }
      navigate("/admin/cinemas");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao salvar o cinema");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={isEdit ? "Editar cinema" : "Novo cinema"}>
      {loading ? (
        <p>Carregando cinema…</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

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
            <span>Endereço</span>
            <input
              type="text"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Cidade</span>
            <input
              type="text"
              value={city}
              onChange={(event) => setCity(event.target.value)}
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
            <Link to="/admin/cinemas" className="text-sm text-gray-600 hover:underline">
              Cancelar
            </Link>
          </div>
        </form>
      )}
    </AdminLayout>
  );
}
