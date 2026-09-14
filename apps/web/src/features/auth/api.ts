import { API_URL } from "../../lib/api-client";
import type { AuthUser, LoginResponse } from "./types";

export async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401 ? "E-mail ou senha inválidos" : `Falha no login (status ${response.status})`,
    );
  }

  return response.json();
}

/** Only creates the account — no token here, register and login are separate steps. */
export async function register(name: string, email: string, password: string): Promise<AuthUser> {
  const response = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "Esse e-mail já tem cadastro"
        : `Falha no cadastro (status ${response.status})`,
    );
  }

  return response.json();
}
