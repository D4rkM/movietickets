import { sql, SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { CreatePaymentDto } from "./dto/create-payment.dto";

export const CENTS_PER_UNIT = 100;
export const PAYMENT_CREATE_TIMEOUT_MS = 15_000;
export const STALE_CREATED_ATTEMPT_MINUTES = 2;

export const ALLOWED_PAYMENT_EVENT_PAYLOAD_KEYS = [
  "attempt_id",
  "mp_payment_id",
  "status",
  "status_detail",
  "amount_cents",
  "installments",
  "payment_method_id",
  "source",
  "error_code",
] as const;

export type PaymentEventSource = "sync" | "webhook";

export interface PaymentEventPayload {
  attempt_id?: string | null;
  mp_payment_id?: string | null;
  status?: string | null;
  status_detail?: string | null;
  amount_cents?: number | null;
  installments?: number | null;
  payment_method_id?: string | null;
  source?: PaymentEventSource | null;
  error_code?: string | null;
}

export const POST_APPROVAL_STATUSES = new Set([
  "approved",
  "refunded",
  "charged_back",
  "in_mediation",
]);

const STATUS_DETAIL_MESSAGES: Record<string, string> = {
  accredited: "Pagamento aprovado!",
  pending_contingency: "Pagamento em análise. Você recebe a confirmação por e-mail.",
  pending_review_manual: "Pagamento em análise. Você recebe a confirmação por e-mail.",
  offline_process: "Pagamento em análise. Você recebe a confirmação por e-mail.",
  deferred_retry: "Pagamento em análise. Você recebe a confirmação por e-mail.",
  cc_rejected_bad_filled_card_number: "Confira o número do cartão.",
  cc_rejected_bad_filled_date: "Confira a data de validade.",
  cc_rejected_bad_filled_security_code: "Confira o código de segurança.",
  cc_rejected_bad_filled_other: "Confira os dados do cartão.",
  cc_rejected_insufficient_amount: "Saldo ou limite insuficiente. Use outro cartão.",
  cc_rejected_invalid_installments: "Esse cartão não aceita esse número de parcelas.",
  cc_rejected_call_for_authorize: "Autorize o pagamento com o banco emissor e tente de novo.",
  cc_rejected_card_disabled: "Cartão desabilitado. Ligue para o banco emissor ou use outro cartão.",
  cc_rejected_duplicated_payment:
    "Você já fez um pagamento com esse valor. Use outro cartão se precisar pagar de novo.",
  cc_rejected_max_attempts: "Limite de tentativas atingido. Use outro cartão.",
  cc_rejected_high_risk: "Pagamento recusado. Use outro cartão.",
  rejected_high_risk: "Pagamento recusado. Use outro cartão.",
};

const IN_ANALYSIS_STATUSES = new Set(["in_process", "pending", "authorized"]);
const DECLINED_STATUSES = new Set(["rejected", "cancelled"]);

/**
 * Pure mapper from Mercado Pago `(status, status_detail)` to a user-facing
 * pt-BR message. Known `status_detail` codes win; unknown details fall back to
 * a status-category message, and unknown statuses fall back to a generic error.
 */
export function paymentStatusMessage(
  status?: string | null,
  statusDetail?: string | null,
): string {
  if (statusDetail && STATUS_DETAIL_MESSAGES[statusDetail]) {
    return STATUS_DETAIL_MESSAGES[statusDetail];
  }
  if (status === "approved") {
    return "Pagamento aprovado!";
  }
  if (status && IN_ANALYSIS_STATUSES.has(status)) {
    return "Pagamento em análise. Você recebe a confirmação por e-mail.";
  }
  if (status && DECLINED_STATUSES.has(status)) {
    return "Pagamento recusado. Confira os dados ou use outro cartão.";
  }
  return "Não foi possível concluir o pagamento. Tente de novo.";
}

/**
 * Copies only whitelisted keys into the `payment_events.payload` object, so
 * card tokens, CPF, email, cardholder name or any other field present on the
 * input object at runtime can never leak into the audit log.
 */
export function buildPaymentEventPayload(
  input: PaymentEventPayload & Record<string, unknown>,
): PaymentEventPayload {
  const payload: PaymentEventPayload = {};
  for (const key of ALLOWED_PAYMENT_EVENT_PAYLOAD_KEYS) {
    if (input[key] !== undefined) {
      (payload as Record<string, unknown>)[key] = input[key];
    }
  }
  return payload;
}

/**
 * Per-row status regression guard: once a `payments` row is `approved`, a
 * late pre-approval notification (`pending`, `in_process`, `authorized`,
 * `rejected`, `cancelled`) must never overwrite it, while post-approval
 * transitions (`refunded`, `charged_back`, `in_mediation`) are allowed.
 */
export function canTransitionPaymentStatus(currentStatus: string, nextStatus: string): boolean {
  if (currentStatus === "approved") {
    return POST_APPROVAL_STATUSES.has(nextStatus);
  }
  return true;
}

export function paymentStatusUpdateGuard(nextStatus: string): SQL {
  if (POST_APPROVAL_STATUSES.has(nextStatus)) {
    return sql`true`;
  }
  return sql`${schema.payments.status} <> 'approved'`;
}

export function calculateBookingAmountCents(seats: { priceCents: number }[]): number {
  return seats.reduce((sum, seat) => sum + seat.priceCents, 0);
}

export function formatBookingSeatLabel(seat: { rowLabel: string; seatNumber: number }): string {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

export function formatBookingDescription(
  movieTitle: string,
  seats: { seat: { rowLabel: string; seatNumber: number } }[],
): string {
  const seatLabels = seats.map((bookingSeat) => formatBookingSeatLabel(bookingSeat.seat)).join(", ");
  return `${movieTitle} - ${seatLabels}`;
}

export interface BuildPaymentRequestParams {
  booking: {
    id: string;
    amountCents: number;
    description: string;
  };
  dto: CreatePaymentDto;
  publicApiUrl: string;
}

/**
 * Pure builder for `Payment.create`. The charged amount always comes from the
 * server-side booking sum (`booking.amountCents / 100`), never from client input,
 * and `idempotencyKey` is pinned to the client's `attemptId`.
 */
export function buildPaymentRequest({ booking, dto, publicApiUrl }: BuildPaymentRequestParams) {
  return {
    body: {
      token: dto.token,
      transaction_amount: booking.amountCents / CENTS_PER_UNIT,
      installments: dto.installments,
      payment_method_id: dto.paymentMethodId,
      issuer_id: dto.issuerId ? Number(dto.issuerId) : undefined,
      payer: {
        email: dto.payer.email,
        identification: {
          type: dto.payer.identification.type,
          number: dto.payer.identification.number,
        },
      },
      external_reference: booking.id,
      notification_url: `${publicApiUrl}/payments/webhook`,
      description: booking.description,
      metadata: { attempt_id: dto.attemptId },
    },
    requestOptions: {
      idempotencyKey: dto.attemptId,
      timeout: PAYMENT_CREATE_TIMEOUT_MS,
    },
  };
}
