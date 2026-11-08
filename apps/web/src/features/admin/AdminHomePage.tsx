import { Link } from "react-router-dom";
import { AdminLayout } from "./AdminLayout";

const SECTIONS = [
  {
    to: "/admin/movies",
    title: "Filmes",
    description: "Cadastrar, editar e remover filmes do catálogo.",
  },
  {
    to: "/admin/cinemas",
    title: "Cinemas",
    description: "Listar, criar e editar unidades de cinema.",
  },
  {
    to: "/admin/rooms",
    title: "Salas",
    description: "Gerenciar salas e layout retangular de assentos.",
  },
  {
    to: "/admin/sessions",
    title: "Sessões",
    description: "Agendar e manter sessões de exibição por sala e horário.",
  },
];

export function AdminHomePage() {
  return (
    <AdminLayout title="Painel administrativo">
      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className="rounded border border-gray-200 p-4 hover:bg-gray-50"
          >
            <h2 className="text-lg font-medium">{section.title}</h2>
            <p className="mt-1 text-sm text-gray-600">{section.description}</p>
          </Link>
        ))}
      </div>
    </AdminLayout>
  );
}
