import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { deleteAdminRoom, listAdminRooms } from "./api";
import type { AdminRoom } from "./types";

export function AdminRoomsPage() {
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    listAdminRooms(accessToken)
      .then((data) => {
        if (!cancelled) {
          setRooms(data);
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

  async function handleDelete(room: AdminRoom) {
    if (!accessToken) return;
    if (!window.confirm(`Deseja excluir a sala "${room.name}"?`)) {
      return;
    }

    setError(null);
    try {
      await deleteAdminRoom(room.id, accessToken);
      setRooms((current) => current?.filter((item) => item.id !== room.id) ?? null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        logout();
        navigate("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao excluir a sala");
    }
  }

  return (
    <AdminLayout
      title="Salas"
      action={
        <Link
          to="/admin/rooms/new"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
        >
          Nova sala
        </Link>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {!rooms && !error && <p>Carregando salas…</p>}
      {rooms?.length === 0 && <p>Nenhuma sala cadastrada.</p>}

      {rooms && rooms.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-600">
                <th className="py-2 pr-4 font-medium">Nome</th>
                <th className="py-2 pr-4 font-medium">Cinema</th>
                <th className="py-2 pr-4 font-medium">Layout</th>
                <th className="py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{room.name}</td>
                  <td className="py-2 pr-4">{room.cinemaName}</td>
                  <td className="py-2 pr-4">
                    {room.rows} × {room.seatsPerRow}
                  </td>
                  <td className="flex gap-3 py-2">
                    <Link
                      to={`/admin/rooms/${room.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      Editar
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDelete(room)}
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
