import { API_URL, assertAuthorized } from "../../lib/api-client";
import type { Ticket } from "./types";

export async function getMyTickets(accessToken: string): Promise<Ticket[]> {
  const response = await fetch(`${API_URL}/bookings/mine`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao carregar os ingressos (status ${response.status})`);
  }

  return response.json();
}
