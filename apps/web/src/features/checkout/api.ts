import { API_URL, assertAuthorized } from "../../lib/api-client";

export interface CheckoutResult {
  checkoutUrl: string;
}

/** Creates a Mercado Pago checkout preference for a pending booking and returns its hosted payment URL. */
export async function createCheckout(bookingId: string, accessToken: string): Promise<CheckoutResult> {
  const response = await fetch(`${API_URL}/bookings/${bookingId}/checkout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (!response.ok) {
    throw new Error(`Falha ao criar o checkout da reserva ${bookingId} (status ${response.status})`);
  }

  return response.json();
}
