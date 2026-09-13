import { API_URL } from "../../lib/api-client";
import type { SeatMapResponse } from "./types";

export async function getSeatMap(sessionId: string, accessToken: string): Promise<SeatMapResponse> {
  const response = await fetch(`${API_URL}/sessions/${sessionId}/seats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Falha ao carregar o mapa de assentos (status ${response.status})`);
  }

  return response.json();
}

export async function bookSeat(
  sessionId: string,
  seatId: string,
  accessToken: string,
): Promise<{ bookingId: string }> {
  const response = await fetch(`${API_URL}/sessions/${sessionId}/seats/${seatId}/book`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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

  if (!response.ok) {
    throw new Error(`Falha ao confirmar a reserva ${bookingId} (status ${response.status})`);
  }
}
