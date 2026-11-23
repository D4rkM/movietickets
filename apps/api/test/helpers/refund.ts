import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AdminModule } from "../../src/admin/admin.module";
import * as schema from "../../src/db/schema";
import { CinemaFixture, createCinemaFixture, createUserWithPassword, TestUser } from "./cinema-fixture";
import { callAs, seatStatusSeenBy } from "./guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./guest-flow-app";
import { newMercadoPagoId } from "./mercado-pago-ids";
import { insertBookingWithPrices, MercadoPagoMocks, recordPayment } from "./pending-booking";

type Db = PostgresJsDatabase<typeof schema>;

/** Auth + seating + booking + payment + refund + admin, Mercado Pago stubbed. */
export function startRefundApp(): Promise<GuestFlowApp> {
  return startGuestFlowApp({ extraImports: [AdminModule] });
}

/**
 * Cinema fixture whose first session starts in a day (well within the
 * cancellation deadline) and whose second one starts in exactly 2 hours, both
 * computed by the DB clock.
 */
export async function createRefundCinemaFixture(db: Db, label: string): Promise<CinemaFixture> {
  const fixture = await createCinemaFixture(db, label, 2);
  const [farSessionId, nearSessionId] = fixture.sessionIds;
  await scheduleSessionStart(db, farSessionId, 24 * 60);
  await scheduleSessionStart(db, nearSessionId, 120);
  return fixture;
}

/** Moves the session's `starts_at` to `now() + minutes`, by the DB clock. */
export async function scheduleSessionStart(db: Db, sessionId: string, minutesFromNow: number): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ startsAt: sql`now() + make_interval(mins => ${minutesFromNow})` })
    .where(eq(schema.sessions.id, sessionId));
}

export async function createAdminUser(db: Db, label: string): Promise<TestUser> {
  const admin = await createUserWithPassword(db, label);
  await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.id));
  return admin;
}

export function signUserToken(ctx: GuestFlowApp, user: TestUser, role: "customer" | "admin" = "customer"): string {
  return ctx.jwtService.sign({ kind: "user", sub: user.id, email: user.email, role });
}

/** A fresh numeric Mercado Pago refund id (see mercado-pago-ids.ts). */
export function newMpRefundId(): number {
  return newMercadoPagoId();
}

export interface PaidBooking {
  bookingId: string;
  paymentId: string;
  /** Numeric Mercado Pago payment id, as a string (the webhook re-fetches it with `Number(...)`). */
  externalPaymentId: string;
  seatIds: string[];
  amountCents: number;
}

/**
 * A booking paid through Mercado Pago: its seats (3000 cents each by default)
 * plus an `approved` payment for their total. Status defaults to `confirmed`.
 */
export async function createPaidBooking(
  db: Db,
  values: { userId: string; sessionId: string; seatIds: string[]; status?: string; priceCents?: number },
): Promise<PaidBooking> {
  const priceCents = values.priceCents ?? 3000;
  const bookingId = await insertBookingWithPrices(db, {
    userId: values.userId,
    sessionId: values.sessionId,
    status: values.status ?? "confirmed",
    seats: values.seatIds.map((seatId) => ({ seatId, priceCents })),
  });
  const amountCents = priceCents * values.seatIds.length;
  const externalPaymentId = String(newMercadoPagoId());
  const paymentId = await recordPayment(db, bookingId, "approved", { externalPaymentId, amountCents });
  return { bookingId, paymentId, externalPaymentId, seatIds: values.seatIds, amountCents };
}

/**
 * The state AC14 of the expiry spec leaves behind: an approved payment landed
 * on an expired booking (seats already freed), flagged for refund review.
 */
export async function createExpiredPaidBooking(
  db: Db,
  values: { userId: string; sessionId: string; seatIds: string[] },
): Promise<PaidBooking> {
  const paid = await createPaidBooking(db, values);
  await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, paid.bookingId));
  await db
    .update(schema.bookings)
    .set({ status: "expired", needsRefundReview: true })
    .where(eq(schema.bookings.id, paid.bookingId));
  return paid;
}

export function cancelAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "POST", `/bookings/${bookingId}/cancel`);
}

export function myBookingsAs(app: NestFastifyApplication, token: string) {
  return callAs(app, token, "GET", "/bookings/mine");
}

export function reviewQueueAs(app: NestFastifyApplication, token: string | undefined) {
  return app.inject({
    method: "GET",
    url: "/admin/refunds/review",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export function adminRefundAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "POST", `/admin/bookings/${bookingId}/refund`);
}

/** Makes `PaymentRefund.total` answer with a refund in the given status; returns its Mercado Pago id. */
export function mercadoPagoAnswersRefund(mocks: MercadoPagoMocks, status: string): number {
  const id = newMpRefundId();
  mocks.refund.total.mockResolvedValue({ id, status });
  return id;
}

/** Makes `PaymentRefund.total` refuse the request with an HTTP error and a Mercado Pago cause code. */
export function mercadoPagoRefusesRefund(mocks: MercadoPagoMocks, httpStatus: number, code?: number): void {
  mocks.refund.total.mockRejectedValue({ status: httpStatus, cause: code ? [{ code }] : [] });
}

/** Makes `PaymentRefund.total` fail with no HTTP answer (timeout). */
export function mercadoPagoTimesOut(mocks: MercadoPagoMocks): void {
  mocks.refund.total.mockRejectedValue(new Error("The operation was aborted due to timeout"));
}

export async function readRefunds(db: Db, bookingId: string): Promise<schema.Refund[]> {
  return db
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.bookingId, bookingId))
    .orderBy(asc(schema.refunds.createdAt));
}

/** Inserts a refund row straight into the DB (state left behind by an earlier request). */
export async function insertRefund(
  db: Db,
  paid: PaidBooking,
  values: { status: string; reason?: string; externalRefundId?: string | null; requestedBy?: string | null },
): Promise<schema.Refund> {
  const [refund] = await db
    .insert(schema.refunds)
    .values({
      bookingId: paid.bookingId,
      paymentId: paid.paymentId,
      status: values.status,
      amountCents: paid.amountCents,
      reason: values.reason ?? "customer_cancellation",
      externalRefundId: values.externalRefundId ?? null,
      requestedBy: values.requestedBy ?? null,
    })
    .returning();
  return refund;
}

/** Backdates `refunds.updated_at`, as if the row had been left alone for that long. */
export async function ageRefund(db: Db, refundId: string, minutes: number): Promise<void> {
  await db
    .update(schema.refunds)
    .set({ updatedAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(schema.refunds.id, refundId));
}

/** Cancels the booking straight in the DB, the way an accepted refund leaves it (seats freed, labels kept). */
export async function markBookingCancelled(db: Db, bookingId: string, seatLabels: string[]): Promise<void> {
  await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, bookingId));
  await db
    .update(schema.bookings)
    .set({ status: "cancelled", cancelledSeatLabels: seatLabels })
    .where(eq(schema.bookings.id, bookingId));
}

export async function flagForRefundReview(db: Db, bookingId: string): Promise<void> {
  await db.update(schema.bookings).set({ needsRefundReview: true }).where(eq(schema.bookings.id, bookingId));
}

export interface ProviderRefundStub {
  id: number;
  status: string;
  amount?: number;
}

/**
 * Makes Mercado Pago report the paid booking's payment with the given status
 * and `refunds[]`, then delivers the webhook for it.
 */
export async function deliverRefundWebhook(
  app: NestFastifyApplication,
  mocks: MercadoPagoMocks,
  paid: PaidBooking,
  paymentStatus: string,
  refunds: ProviderRefundStub[],
): Promise<void> {
  mocks.payment.get.mockResolvedValue({
    id: Number(paid.externalPaymentId),
    status: paymentStatus,
    status_detail: paymentStatus === "refunded" ? "refunded" : null,
    external_reference: paid.bookingId,
    transaction_amount: paid.amountCents / 100,
    refunds: refunds.map((refund) => ({ amount: paid.amountCents / 100, ...refund })),
  });
  const response = await app.inject({
    method: "POST",
    url: "/payments/webhook",
    payload: { type: "payment", data: { id: paid.externalPaymentId } },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Webhook failed with ${response.statusCode}: ${response.body}`);
  }
}

export function eventTypes(events: schema.PaymentEvent[]): string[] {
  return events.map((event) => event.type);
}

export function eventsOfType(events: schema.PaymentEvent[], type: string): schema.PaymentEvent[] {
  return events.filter((event) => event.type === type);
}

/** Seat map status of each seat, as another user sees it. */
export async function seatStatusesSeenBy(
  app: NestFastifyApplication,
  token: string,
  sessionId: string,
  seatIds: string[],
): Promise<(string | undefined)[]> {
  return Promise.all(seatIds.map((seatId) => seatStatusSeenBy(app, token, sessionId, seatId)));
}

/** Seat labels ("A1") of the given seat ids, in seat order. */
export async function seatLabelsOf(db: Db, seatIds: string[]): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.seats)
    .where(inArray(schema.seats.id, seatIds))
    .orderBy(asc(schema.seats.rowLabel), asc(schema.seats.seatNumber));
  return rows.map((row) => `${row.rowLabel}${row.seatNumber}`);
}

/** `indexname → indexdef` of every index on `refunds`. */
export async function refundIndexDefinitions(db: Db): Promise<Map<string, string>> {
  const rows = await db.execute<{ indexname: string; indexdef: string }>(
    sql`select indexname, indexdef from pg_indexes where tablename = 'refunds'`,
  );
  return new Map(rows.map((row) => [row.indexname, row.indexdef]));
}

export async function cancelledSeatLabelsColumn(db: Db) {
  const [row] = await db.execute<{ data_type: string; is_nullable: string; column_default: string | null }>(
    sql`select data_type, is_nullable, column_default from information_schema.columns
        where table_name = 'bookings' and column_name = 'cancelled_seat_labels'`,
  );
  return row && { dataType: row.data_type, isNullable: row.is_nullable, columnDefault: row.column_default };
}

/** Raw SQL of the migration whose file name starts with `prefix` (e.g. "0005_"). */
export function readMigrationSql(prefix: string): string {
  const dir = join(__dirname, "../../drizzle");
  const file = readdirSync(dir).find((name) => name.startsWith(prefix) && name.endsWith(".sql"));
  if (!file) throw new Error(`Migration ${prefix} not found`);
  return readFileSync(join(dir, file), "utf8");
}
