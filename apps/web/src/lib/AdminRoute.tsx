import { Link, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";

export function AdminRoute() {
  const { accessToken, user } = useAuth();

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  if (user?.role !== "admin") {
    return (
      <main className="mx-auto max-w-xl px-4 py-12 text-center">
        <h1 className="text-2xl font-semibold">Acesso restrito</h1>
        <p className="mt-2 text-sm text-gray-600">
          Esta área é exclusiva para administradores.
        </p>
        <Link
          to="/movies"
          className="mt-4 inline-block rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
        >
          Voltar para os filmes
        </Link>
      </main>
    );
  }

  return <Outlet />;
}
