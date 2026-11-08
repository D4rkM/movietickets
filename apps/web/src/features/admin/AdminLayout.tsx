import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ProfileMenu } from "../auth/ProfileMenu";

interface AdminLayoutProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}

export function AdminLayout({ title, action, children }: AdminLayoutProps) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-4">
        <div className="flex flex-wrap items-center gap-4">
          <Link to="/admin" className="text-sm font-semibold text-gray-900 hover:underline">
            Painel Admin
          </Link>
          <nav aria-label="Navegação admin" className="flex flex-wrap gap-3 text-sm text-gray-600">
            <Link to="/admin/movies" className="hover:text-gray-900 hover:underline">
              Filmes
            </Link>
            <Link to="/admin/cinemas" className="hover:text-gray-900 hover:underline">
              Cinemas
            </Link>
            <Link to="/admin/rooms" className="hover:text-gray-900 hover:underline">
              Salas
            </Link>
            <Link to="/admin/sessions" className="hover:text-gray-900 hover:underline">
              Sessões
            </Link>
            <Link to="/movies" className="hover:text-gray-900 hover:underline">
              Catálogo
            </Link>
          </nav>
        </div>
        <ProfileMenu />
      </header>

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {action}
      </div>

      {children}
    </main>
  );
}
