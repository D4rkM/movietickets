import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { deleteAdminSession, listAdminSessions } from "./api";
import { formatPriceReais, formatSaoPauloDateTime } from "./format";
import type { AdminSession } from "./types";

export function AdminSessionsPage() {
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    listAdminSessions(accessToken)
      .then((data) => {
        if (!cancelled) {
          setSessions(data);
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

  async function handleDelete(session: AdminSession) {
    if (!accessToken) return;
    if (
      !window.confirm(
        `Deseja excluir a sessão de "${session.movie.title}" em ${formatSaoPauloDateTime(session.startsAt)}?`,
      )
    ) {
      return;
    }

    setError(null);
    try {
      await deleteAdminSession(session.id, accessToken);
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao excluir a sessão");
    }
  }

  return (
    <AdminLayout
      title="Sessões"
      action={
        <Link
          to="/admin/sessions/new"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
        >
          Nova sessão
        </Link>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {!sessions && !error && <p>Carregando sessões…</p>}
      {sessions?.length === 0 && <p>Nenhuma sessão cadastrada.</p>}

      {sessions && sessions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-600">
                <th className="py-2 pr-4 font-medium">Filme</th>
                <th className="py-2 pr-4 font-medium">Cinema / Sala</th>
                <th className="py-2 pr-4 font-medium">Início (São Paulo)</th>
                <th className="py-2 pr-4 font-medium">Preço</th>
                <th className="py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{session.movie.title}</td>
                  <td className="py-2 pr-4">
                    {session.cinema.name} · {session.room.name}
                  </td>
                  <td className="py-2 pr-4">{formatSaoPauloDateTime(session.startsAt)}</td>
                  <td className="py-2 pr-4">{formatPriceReais(session.priceCents)}</td>
                  <td className="flex gap-3 py-2">
                    <Link
                      to={`/admin/sessions/${session.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      Editar
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDelete(session)}
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
