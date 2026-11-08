import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../features/auth/AuthContext";
import { ACCESS_TOKEN_STORAGE_KEY, apiFetch, USER_STORAGE_KEY } from "./api-client";
import { AdminRoute } from "./AdminRoute";

function AdminProbePage() {
  useEffect(() => {
    void apiFetch("/admin/movies");
  }, []);
  return <p>Painel administrativo</p>;
}

function renderAdminRoute(initialPath = "/admin") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<AdminProbePage />} />
            <Route path="/admin/movies" element={<AdminProbePage />} />
          </Route>
          <Route path="/login" element={<p>Login page</p>} />
          <Route path="/movies" element={<p>Movies page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AdminRoute", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("AC21: deve redirecionar para /login quando não há token de usuário em /admin", async () => {
    // GIVEN nenhum token de usuário armazenado
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // WHEN o visitante tenta abrir /admin
    renderAdminRoute("/admin");

    // THEN é redirecionado para /login sem chamar rotas admin
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(screen.queryByText("Painel administrativo")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC21: deve redirecionar sub-rotas de /admin para /login quando não há token de usuário", async () => {
    // GIVEN nenhum token de usuário armazenado
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // WHEN o visitante tenta abrir /admin/movies
    renderAdminRoute("/admin/movies");

    // THEN é redirecionado para /login
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC21: deve mostrar 'Acesso restrito' para usuário customer e não chamar nenhuma rota /admin/*", async () => {
    // GIVEN um usuário autenticado com role customer
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "customer-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "u-1", name: "Cliente", email: "cliente@test.com", role: "customer" }),
    );

    // WHEN ele tenta acessar /admin
    renderAdminRoute("/admin");

    // THEN vê "Acesso restrito" com link para /movies e nenhuma chamada /admin/* é disparada
    expect(await screen.findByRole("heading", { name: "Acesso restrito" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Voltar para os filmes/i })).toHaveAttribute(
      "href",
      "/movies",
    );
    expect(screen.queryByText("Painel administrativo")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC21: deve mostrar a área admin quando o usuário tem role admin", async () => {
    // GIVEN um usuário autenticado com role admin
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as Response));
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "admin-token");
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "u-admin", name: "Admin", email: "admin@test.com", role: "admin" }),
    );

    // WHEN ele acessa /admin
    renderAdminRoute("/admin");

    // THEN o conteúdo da área admin é exibido
    expect(await screen.findByText("Painel administrativo")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Acesso restrito" })).not.toBeInTheDocument();
  });
});
