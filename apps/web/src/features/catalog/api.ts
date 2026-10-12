import { API_URL } from "../../lib/api-client";
import type { CatalogMovie } from "./types";

export interface CatalogFilters {
  city?: string;
  cinemaId?: string;
  date?: string;
}

export async function listMovies(filters: CatalogFilters = {}): Promise<CatalogMovie[]> {
  const params = new URLSearchParams();
  if (filters.city) params.set("city", filters.city);
  if (filters.cinemaId) params.set("cinemaId", filters.cinemaId);
  if (filters.date) params.set("date", filters.date);
  const query = params.toString();

  const response = await fetch(`${API_URL}/movies${query ? `?${query}` : ""}`);

  if (!response.ok) {
    throw new Error(`Falha ao carregar o catálogo (status ${response.status})`);
  }

  return response.json();
}
