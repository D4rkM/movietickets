import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext";
import { RegisterPage } from "./RegisterPage";

function renderRegisterPage() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RegisterPage (integration)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should create the account and redirect to /login", async () => {
    // GIVEN the API accepts the new account
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: "user-1", name: "Ana", email: "ana@test.com", role: "customer" }),
    } as Response);
    renderRegisterPage();

    // WHEN the user submits the register form
    await userEvent.type(screen.getByLabelText("Nome"), "Ana");
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@test.com");
    await userEvent.type(screen.getByLabelText("Senha"), "password123");
    await userEvent.type(screen.getByLabelText("Confirmar senha"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));

    // THEN it sends name/email/password and redirects to the login page
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/register"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Ana", email: "ana@test.com", password: "password123" }),
      }),
    );
    expect(await screen.findByText("Login page")).toBeInTheDocument();
  });

  it("should show an error and not submit when the passwords don't match", async () => {
    // GIVEN the user fills mismatched passwords
    renderRegisterPage();
    await userEvent.type(screen.getByLabelText("Nome"), "Ana");
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@test.com");
    await userEvent.type(screen.getByLabelText("Senha"), "password123");
    await userEvent.type(screen.getByLabelText("Confirmar senha"), "different123");

    // WHEN the user tries to submit
    expect(screen.getByText("Senhas não coincidem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar conta" })).toBeDisabled();

    // THEN it never calls the API
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should show an error message when the email is already registered", async () => {
    // GIVEN the API rejects the email as a duplicate
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 409 } as Response);
    renderRegisterPage();

    // WHEN the user submits the register form
    await userEvent.type(screen.getByLabelText("Nome"), "Ana");
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@test.com");
    await userEvent.type(screen.getByLabelText("Senha"), "password123");
    await userEvent.type(screen.getByLabelText("Confirmar senha"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));

    // THEN it shows an error and stays on the register page
    expect(await screen.findByRole("alert")).toHaveTextContent("Esse e-mail já tem cadastro");
  });
});
