import { extractProviderErrorCode, extractProviderHttpStatus } from "../mercadopago/mercadopago-errors";

/** Same budget as `Payment.create`: the SDK's own retries reuse the idempotency key within it. */
export const REFUND_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Pure builder for `PaymentRefund.total`: a total refund (no `amount`) of the
 * Mercado Pago payment, with `refunds.id` pinned as the idempotency key so a
 * retry of the same row can never create a second refund.
 */
export function buildRefundRequest(externalPaymentId: string, refundId: string) {
  return {
    payment_id: externalPaymentId,
    requestOptions: {
      idempotencyKey: refundId,
      timeout: REFUND_REQUEST_TIMEOUT_MS,
    },
  };
}

export type RefundProviderFailure =
  | { kind: "in_progress" }
  | { kind: "invalid"; errorCode: string }
  | { kind: "timeout" };

/**
 * Maps a `PaymentRefund.total` failure: 409 = same idempotency key still being
 * processed; any other 4xx = request refused with no refund created; anything
 * else (timeout, network, 5xx after the SDK's retries) = outcome unknown.
 */
export function classifyRefundProviderError(err: unknown): RefundProviderFailure {
  const status = extractProviderHttpStatus(err);
  if (status === 409) return { kind: "in_progress" };
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "invalid", errorCode: extractProviderErrorCode(err, status) };
  }
  return { kind: "timeout" };
}
