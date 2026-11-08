import { API_URL, apiFetch, assertAuthorized } from "../../lib/api-client";
import type { TicketType } from "../seating/types";

/** Error `code` the backend sends on a 409 when the pending booking is past its deadline. */
export const BOOKING_EXPIRED_CODE = "BOOKING_EXPIRED";

/** Thrown when the backend rejects the request because the pending booking expired. */
export class BookingExpiredError extends Error {
  constructor() {
    super("Sua reserva expirou. Escolha os assentos novamente.");
    this.name = "BookingExpiredError";
  }
}

/**
 * Thrown when the payment call receives no definitive answer (network failure or
 * 504 `PAYMENT_PROVIDER_TIMEOUT`), meaning the client must replay the exact same
 * `attemptId` and `token`.
 */
export class PaymentTimeoutError extends Error {
  constructor(message = "Não obtivemos resposta do provedor de pagamento. Tente de novo.") {
    super(message);
    this.name = "PaymentTimeoutError";
  }
}

export interface PaymentSummarySeat {
  seatId: string;
  label: string;
  ticketType: TicketType;
  priceCents: number;
}

export interface PaymentSummary {
  bookingId: string;
  status: string;
  expiresAt: string;
  amountCents: number;
  currency: string;
  description: string;
  seats: PaymentSummarySeat[];
}

export interface PaymentPayer {
  email: string;
  identification: {
    type: string;
    number: string;
  };
}

export interface CreatePaymentInput {
  attemptId: string;
  token: string;
  paymentMethodId: string;
  issuerId?: string;
  installments: number;
  payer: PaymentPayer;
}

export interface PaymentAttemptResult {
  attemptId: string;
  paymentId: string;
  status: string;
  statusDetail: string | null;
  message: string;
  bookingStatus: string;
}

interface ErrorBody {
  code?: string;
  message?: string;
}

/** Reads `code` and `message` from an error response body, tolerating empty or non-JSON bodies. */
async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      return {
        code: "code" in body && typeof body.code === "string" ? body.code : undefined,
        message: "message" in body && typeof body.message === "string" ? body.message : undefined,
      };
    }
  } catch {
    // Non-JSON error body: fall back to status-based handling.
  }
  return {};
}

/** Fetches the server-calculated summary and total for a pending booking. */
export async function getPaymentSummary(
  bookingId: string,
  accessToken: string,
): Promise<PaymentSummary> {
  const response = await apiFetch(`${API_URL}/bookings/${bookingId}/payment-summary`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertAuthorized(response);

  if (response.status === 409) {
    const { code, message } = await readErrorBody(response);
    if (code === BOOKING_EXPIRED_CODE) {
      throw new BookingExpiredError();
    }
    throw new Error(message ?? `Falha ao carregar o resumo da reserva ${bookingId} (status 409)`);
  }

  if (!response.ok) {
    const { message } = await readErrorBody(response);
    throw new Error(
      message ?? `Falha ao carregar o resumo da reserva ${bookingId} (status ${response.status})`,
    );
  }

  return response.json();
}

/** Submits an idempotent card payment attempt for a pending booking. */
export async function submitPayment(
  bookingId: string,
  input: CreatePaymentInput,
  accessToken: string,
): Promise<PaymentAttemptResult> {
  const payload: CreatePaymentInput = {
    attemptId: input.attemptId,
    token: input.token,
    paymentMethodId: input.paymentMethodId,
    issuerId: input.issuerId,
    installments: input.installments,
    payer: {
      email: input.payer.email,
      identification: {
        type: input.payer.identification.type,
        number: input.payer.identification.number,
      },
    },
  };

  let response: Response;
  try {
    response = await apiFetch(`${API_URL}/bookings/${bookingId}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new PaymentTimeoutError();
  }

  assertAuthorized(response);

  if (response.status === 504) {
    const { message } = await readErrorBody(response);
    throw new PaymentTimeoutError(message);
  }

  if (response.status === 409) {
    const { code, message } = await readErrorBody(response);
    if (code === BOOKING_EXPIRED_CODE) {
      throw new BookingExpiredError();
    }
    throw new Error(message ?? `Falha ao processar o pagamento da reserva ${bookingId} (status 409)`);
  }

  if (!response.ok) {
    const { message } = await readErrorBody(response);
    throw new Error(
      message ?? `Falha ao processar o pagamento da reserva ${bookingId} (status ${response.status})`,
    );
  }

  return response.json();
}
