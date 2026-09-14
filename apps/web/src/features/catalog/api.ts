import { API_URL } from "../../lib/api-client";
import type { CatalogMovie } from "./types";

export async function listMovies(): Promise<CatalogMovie[]> {
  const response = await fetch(`${API_URL}/movies`);

  if (!response.ok) {
    throw new Error(`Falha ao carregar o catálogo (status ${response.status})`);
  }

  return response.json();
}
