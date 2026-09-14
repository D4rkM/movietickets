import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext";
import { LoginPage } from "./LoginPage";

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/movies" element={<p>Movies page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage (integration)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should redirect to /movies after a successful login", async () => {
    // GIVEN the API accepts the credentials
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "token-123" }),
    } as Response);
    renderLoginPage();

    // WHEN the user submits the login form
    await userEvent.type(screen.getByLabelText("E-mail"), "user@test.com");
    await userEvent.type(screen.getByLabelText("Senha"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    // THEN it navigates to the movies page
    expect(await screen.findByText("Movies page")).toBeInTheDocument();
  });

  it("should show an error message when the credentials are rejected", async () => {
    // GIVEN the API rejects the credentials
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);
    renderLoginPage();

    // WHEN the user submits the login form
    await userEvent.type(screen.getByLabelText("E-mail"), "user@test.com");
    await userEvent.type(screen.getByLabelText("Senha"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    // THEN it shows an error and stays on the login page
    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail ou senha inválidos");
  });
});
