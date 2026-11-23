import { API_URL, apiFetch, assertAuthorized, readErrorBody } from "../../lib/api-client";
import type { CancelBookingResult, Ticket } from "./types";

/** Error `code` the backend sends on a 504 when Mercado Pago didn't answer the refund in time. */
export const REFUND_PROVIDER_TIMEOUT_CODE = "REFUND_PROVIDER_TIMEOUT";

const NETWORK_FAILURE_MESSAGE = "Não foi possível falar com o servidor. Tente de novo.";

/**
 * Thrown when `POST /bookings/:id/cancel` fails. Carries the backend's `code`
 * and pt-BR `message`; `retryable` means the same request should be sent again
 * (504 provider timeout or a network failure — the backend replays the refund
 * with the same idempotency key).
 */
export class CancelBookingError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CancelBookingError";
    this.status = status;
    this.code = code;
  }

  get retryable(): boolean {
    return this.status === 504 || this.status === 0;
  }
}

export async function getMyTickets(accessToken: string): Promise<Ticket[]> {
  const response = await apiFetch(`${API_URL}/bookings/mine`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao carregar os ingressos (status ${response.status})`);
  }

  return response.json();
}

/** Cancels a confirmed booking, refunding its approved payment in full. */
export async function cancelBooking(bookingId: string, accessToken: string): Promise<CancelBookingResult> {
  let response: Response;
  try {
    response = await apiFetch(`${API_URL}/bookings/${bookingId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new CancelBookingError(NETWORK_FAILURE_MESSAGE, 0);
  }
  assertAuthorized(response);

  if (!response.ok) {
    const { code, message } = await readErrorBody(response);
    throw new CancelBookingError(
      message ?? `Falha ao cancelar o ingresso (status ${response.status})`,
      response.status,
      code,
    );
  }

  return response.json();
}
