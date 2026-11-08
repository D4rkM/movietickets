import { API_URL, apiFetch, assertAuthorized } from "../../lib/api-client";
import type {
  AdminCinema,
  AdminMovie,
  AdminRoom,
  AdminSession,
  CreateCinemaInput,
  CreateMovieInput,
  CreateRoomInput,
  CreateSessionInput,
  UpdateCinemaInput,
  UpdateMovieInput,
  UpdateRoomInput,
  UpdateSessionInput,
} from "./types";

function authHeaders(accessToken: string, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/** Extracts the human-readable error message from a NestJS HTTP exception payload. */
async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const msg = (body as { message: unknown }).message;
      if (typeof msg === "string" && msg.trim() !== "") {
        return msg;
      }
      if (Array.isArray(msg) && msg.length > 0) {
        return msg.filter((item): item is string => typeof item === "string").join(", ");
      }
    }
  } catch {
    // Non-JSON body: fall back to the default message below.
  }
  return `${fallback} (status ${response.status})`;
}

async function parseJsonOrThrow<T>(response: Response, fallback: string): Promise<T> {
  assertAuthorized(response);
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, fallback));
  }
  return response.json() as Promise<T>;
}

async function assertNoContentOrThrow(response: Response, fallback: string): Promise<void> {
  assertAuthorized(response);
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, fallback));
  }
}

export async function listAdminMovies(accessToken: string): Promise<AdminMovie[]> {
  const response = await apiFetch(`${API_URL}/admin/movies`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminMovie[]>(response, "Falha ao carregar os filmes");
}

export async function getAdminMovie(id: string, accessToken: string): Promise<AdminMovie> {
  const response = await apiFetch(`${API_URL}/admin/movies/${id}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminMovie>(response, "Falha ao carregar o filme");
}

export async function createAdminMovie(
  input: CreateMovieInput,
  accessToken: string,
): Promise<AdminMovie> {
  const response = await apiFetch(`${API_URL}/admin/movies`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminMovie>(response, "Falha ao criar o filme");
}

export async function updateAdminMovie(
  id: string,
  input: UpdateMovieInput,
  accessToken: string,
): Promise<AdminMovie> {
  const response = await apiFetch(`${API_URL}/admin/movies/${id}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminMovie>(response, "Falha ao atualizar o filme");
}

export async function deleteAdminMovie(id: string, accessToken: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/admin/movies/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  return assertNoContentOrThrow(response, "Falha ao excluir o filme");
}

export async function listAdminCinemas(accessToken: string): Promise<AdminCinema[]> {
  const response = await apiFetch(`${API_URL}/admin/cinemas`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminCinema[]>(response, "Falha ao carregar os cinemas");
}

export async function getAdminCinema(id: string, accessToken: string): Promise<AdminCinema> {
  const response = await apiFetch(`${API_URL}/admin/cinemas/${id}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminCinema>(response, "Falha ao carregar o cinema");
}

export async function createAdminCinema(
  input: CreateCinemaInput,
  accessToken: string,
): Promise<AdminCinema> {
  const response = await apiFetch(`${API_URL}/admin/cinemas`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminCinema>(response, "Falha ao criar o cinema");
}

export async function updateAdminCinema(
  id: string,
  input: UpdateCinemaInput,
  accessToken: string,
): Promise<AdminCinema> {
  const response = await apiFetch(`${API_URL}/admin/cinemas/${id}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminCinema>(response, "Falha ao atualizar o cinema");
}

export async function listAdminRooms(
  accessToken: string,
  cinemaId?: string,
): Promise<AdminRoom[]> {
  const query = cinemaId ? `?cinemaId=${encodeURIComponent(cinemaId)}` : "";
  const response = await apiFetch(`${API_URL}/admin/rooms${query}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminRoom[]>(response, "Falha ao carregar as salas");
}

export async function getAdminRoom(id: string, accessToken: string): Promise<AdminRoom> {
  const response = await apiFetch(`${API_URL}/admin/rooms/${id}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminRoom>(response, "Falha ao carregar a sala");
}

export async function createAdminRoom(
  input: CreateRoomInput,
  accessToken: string,
): Promise<AdminRoom> {
  const response = await apiFetch(`${API_URL}/admin/rooms`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminRoom>(response, "Falha ao criar a sala");
}

export async function updateAdminRoom(
  id: string,
  input: UpdateRoomInput,
  accessToken: string,
): Promise<AdminRoom> {
  const response = await apiFetch(`${API_URL}/admin/rooms/${id}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminRoom>(response, "Falha ao atualizar a sala");
}

export async function deleteAdminRoom(id: string, accessToken: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/admin/rooms/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  return assertNoContentOrThrow(response, "Falha ao excluir a sala");
}

export async function listAdminSessions(
  accessToken: string,
  includePast = false,
): Promise<AdminSession[]> {
  const query = includePast ? "?includePast=true" : "";
  const response = await apiFetch(`${API_URL}/admin/sessions${query}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminSession[]>(response, "Falha ao carregar as sessões");
}

export async function getAdminSession(id: string, accessToken: string): Promise<AdminSession> {
  const response = await apiFetch(`${API_URL}/admin/sessions/${id}`, {
    headers: authHeaders(accessToken),
  });
  return parseJsonOrThrow<AdminSession>(response, "Falha ao carregar a sessão");
}

export async function createAdminSession(
  input: CreateSessionInput,
  accessToken: string,
): Promise<AdminSession> {
  const response = await apiFetch(`${API_URL}/admin/sessions`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminSession>(response, "Falha ao criar a sessão");
}

export async function updateAdminSession(
  id: string,
  input: UpdateSessionInput,
  accessToken: string,
): Promise<AdminSession> {
  const response = await apiFetch(`${API_URL}/admin/sessions/${id}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(input),
  });
  return parseJsonOrThrow<AdminSession>(response, "Falha ao atualizar a sessão");
}

export async function deleteAdminSession(id: string, accessToken: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/admin/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  return assertNoContentOrThrow(response, "Falha ao excluir a sessão");
}
