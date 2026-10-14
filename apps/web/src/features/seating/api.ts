import { API_URL, apiFetch, assertAuthorized } from "../../lib/api-client";
import type { SeatMapResponse, TicketType } from "./types";

export async function getSeatMap(sessionId: string, accessToken: string): Promise<SeatMapResponse> {
  const response = await apiFetch(`${API_URL}/sessions/${sessionId}/seats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao carregar o mapa de assentos (status ${response.status})`);
  }

  return response.json();
}

export interface SeatBookingChoice {
  seatId: string;
  ticketType: TicketType;
  halfPriceDocument?: string;
}

/**
 * Books every given seat in a single atomic request. The backend wraps the
 * inserts in one DB transaction, so either every seat is booked under one
 * booking, or (e.g. a seat was taken concurrently) none are — no partial
 * bookings left behind for the caller to reconcile.
 */
export async function bookSeats(
  sessionId: string,
  seats: SeatBookingChoice[],
  accessToken: string,
): Promise<{ bookingId: string }> {
  const response = await apiFetch(`${API_URL}/sessions/${sessionId}/book`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ seats }),
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao reservar os assentos (status ${response.status})`);
  }

  const results: Array<{ bookingId: string }> = await response.json();
  return { bookingId: results[0].bookingId };
}

export class SeatConflictError extends Error {
  constructor() {
    super("Esse assento já foi reservado por outra pessoa.");
    this.name = "SeatConflictError";
  }
}

export interface HoldSeatResult {
  seatId: string;
  status: "held";
  expiresInSeconds: number;
}

export async function holdSeat(sessionId: string, seatId: string, accessToken: string): Promise<HoldSeatResult> {
  const response = await apiFetch(`${API_URL}/sessions/${sessionId}/seats/${seatId}/hold`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (response.status === 409) {
    throw new SeatConflictError();
  }
  if (!response.ok) {
    throw new Error(`Falha ao segurar o assento (status ${response.status})`);
  }

  return response.json();
}

export async function releaseSeat(sessionId: string, seatId: string, accessToken: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/sessions/${sessionId}/seats/${seatId}/hold`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao liberar o assento (status ${response.status})`);
  }
}

/** Releases every seat the user is currently holding in this session — used when they back out of checkout. */
export async function releaseAllHolds(sessionId: string, accessToken: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/sessions/${sessionId}/holds`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao liberar os assentos (status ${response.status})`);
  }
}
