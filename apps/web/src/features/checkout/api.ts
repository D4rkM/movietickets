import { API_URL, apiFetch, assertAuthorized } from "../../lib/api-client";

export interface CheckoutResult {
  checkoutUrl: string;
}

/** Error `code` the backend sends on a 409 when the pending booking is past its deadline. */
export const BOOKING_EXPIRED_CODE = "BOOKING_EXPIRED";

/** Thrown when the backend rejects the checkout because the pending booking expired. */
export class BookingExpiredError extends Error {
  constructor() {
    super("Sua reserva expirou. Escolha os assentos novamente.");
    this.name = "BookingExpiredError";
  }
}

/** Reads the error `code` from a 409 body, tolerating empty or non-JSON bodies. */
async function readConflictCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string") {
      return body.code;
    }
  } catch {
    // Not a JSON body: treat it as a generic conflict.
  }
  return undefined;
}

/** Creates a Mercado Pago checkout preference for a pending booking and returns its hosted payment URL. */
export async function createCheckout(bookingId: string, accessToken: string): Promise<CheckoutResult> {
  const response = await apiFetch(`${API_URL}/bookings/${bookingId}/checkout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (response.status === 409 && (await readConflictCode(response)) === BOOKING_EXPIRED_CODE) {
    throw new BookingExpiredError();
  }

  if (!response.ok) {
    throw new Error(`Falha ao criar o checkout da reserva ${bookingId} (status ${response.status})`);
  }

  return response.json();
}
