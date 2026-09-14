import { API_URL, assertAuthorized } from "../../lib/api-client";
import type { SeatMapResponse, TicketType } from "./types";

export async function getSeatMap(sessionId: string, accessToken: string): Promise<SeatMapResponse> {
  const response = await fetch(`${API_URL}/sessions/${sessionId}/seats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao carregar o mapa de assentos (status ${response.status})`);
  }

  return response.json();
}

export async function bookSeat(
  sessionId: string,
  seatId: string,
  accessToken: string,
  ticketType: TicketType,
  halfPriceDocument?: string,
): Promise<{ bookingId: string; priceCents: number }> {
  const response = await fetch(`${API_URL}/sessions/${sessionId}/seats/${seatId}/book`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ticketType, halfPriceDocument }),
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao reservar o assento ${seatId} (status ${response.status})`);
  }

  return response.json();
}

export async function confirmBooking(bookingId: string, accessToken: string): Promise<void> {
  const response = await fetch(`${API_URL}/bookings/${bookingId}/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao confirmar a reserva ${bookingId} (status ${response.status})`);
  }
}
