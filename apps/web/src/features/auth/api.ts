import { API_URL } from "../../lib/api-client";
import type { LoginResponse } from "./types";

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
