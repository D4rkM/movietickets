/**
 * Numeric Mercado Pago ids (payments and refunds) for integration tests.
 *
 * Every suite shares one Postgres, and `payments.external_payment_id` is
 * unique: a webhook whose id matches a row another suite created is applied to
 * that row instead (it is matched by external id first). So ids must never
 * collide across parallel Jest workers. Each worker gets its own range,
 * `JEST_WORKER_ID * 1e13`, offset by the start time in milliseconds (< 1e13
 * until the year 2286) so consecutive runs don't reuse ids either; within the
 * process a single counter serves every helper, so payment and refund ids
 * never collide with each other.
 */
const WORKER_RANGE = 10_000_000_000_000;
let nextId = Number(process.env.JEST_WORKER_ID ?? "0") * WORKER_RANGE + Date.now();

export function newMercadoPagoId(): number {
  return nextId++;
}
