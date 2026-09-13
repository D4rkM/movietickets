import type { SeatMapResponse } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export async function getSeatMap(sessionId: string, accessToken: string): Promise<SeatMapResponse> {
  const response = await fetch(`${API_URL}/sessions/${sessionId}/seats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Falha ao carregar o mapa de assentos (status ${response.status})`);
  }

  return response.json();
}
