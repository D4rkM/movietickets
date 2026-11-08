import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { listAdminCinemas } from "./api";
import type { AdminCinema } from "./types";

export function AdminCinemasPage() {
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();
  const [cinemas, setCinemas] = useState<AdminCinema[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    listAdminCinemas(accessToken)
      .then((data) => {
        if (!cancelled) {
          setCinemas(data);
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

  return (
    <AdminLayout
      title="Cinemas"
      action={
        <Link
          to="/admin/cinemas/new"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
        >
          Novo cinema
        </Link>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {!cinemas && !error && <p>Carregando cinemas…</p>}
      {cinemas?.length === 0 && <p>Nenhum cinema cadastrado.</p>}

      {cinemas && cinemas.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-600">
                <th className="py-2 pr-4 font-medium">Nome</th>
                <th className="py-2 pr-4 font-medium">Endereço</th>
                <th className="py-2 pr-4 font-medium">Cidade</th>
                <th className="py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {cinemas.map((cinema) => (
                <tr key={cinema.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{cinema.name}</td>
                  <td className="py-2 pr-4">{cinema.address}</td>
                  <td className="py-2 pr-4">{cinema.city}</td>
                  <td className="py-2">
                    <Link
                      to={`/admin/cinemas/${cinema.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      Editar
                    </Link>
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
