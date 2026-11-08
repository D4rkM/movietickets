import { Logger } from "@nestjs/common";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { BookingService } from "../../src/booking/booking.service";
import * as schema from "../../src/db/schema";
import { PAYMENT_CLIENT } from "../../src/payment/mercadopago.providers";
import { callAs } from "./guest-flow";

type Db = PostgresJsDatabase<typeof schema>;

/** POST /sessions/:id/book with full-price tickets for every seat. */
export function bookSeatsAs(app: NestFastifyApplication, token: string, sessionId: string, seatIds: string[]) {
  return callAs(app, token, "POST", `/sessions/${sessionId}/book`, {
    seats: seatIds.map((seatId) => ({ seatId, ticketType: "full" })),
  });
}

/** POST /sessions/:id/seats/:seatId/book for a single seat. */
export function bookSingleSeatAs(
  app: NestFastifyApplication,
  token: string,
  sessionId: string,
  seatId: string,
  ticketType: "full" | "half" = "full",
  halfPriceDocument?: string,
) {
  return callAs(app, token, "POST", `/sessions/${sessionId}/seats/${seatId}/book`, {
    ticketType,
    ...(halfPriceDocument ? { halfPriceDocument } : {}),
  });
}

/** Books the seats through the API, failing loudly on anything but 201; returns the new booking id. */
export async function bookSeatsAsOrFail(
  app: NestFastifyApplication,
  token: string,
  sessionId: string,
  seatIds: string[],
): Promise<string> {
  const response = await bookSeatsAs(app, token, sessionId, seatIds);
  if (response.statusCode !== 201) {
    throw new Error(`Booking failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json()[0].bookingId;
}

export function validPaymentBody(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: randomUUID(),
    token: "card-token-e2e",
    paymentMethodId: "visa",
    issuerId: "25",
    installments: 1,
    payer: {
      email: "comprador@test.com",
      identification: { type: "CPF", number: "12345678909" },
    },
    ...overrides,
  };
}

export function payBookingAs(
  app: NestFastifyApplication,
  token: string,
  bookingId: string,
  body: Record<string, unknown> = validPaymentBody(),
) {
  return callAs(app, token, "POST", `/bookings/${bookingId}/payments`, body);
}

export function paymentSummaryAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "GET", `/bookings/${bookingId}/payment-summary`);
}

export function removedCheckoutProAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "POST", `/bookings/${bookingId}/checkout`);
}

export function checkoutAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return payBookingAs(app, token, bookingId);
}

export function confirmAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "POST", `/bookings/${bookingId}/confirm`);
}

/** Inserts a booking (default `pending`) and its seat rows straight into the DB. */
export async function insertBooking(
  db: Db,
  values: { userId: string; sessionId: string; seatIds: string[]; status?: string },
): Promise<string> {
  const [{ id }] = await db
    .insert(schema.bookings)
    .values({ userId: values.userId, sessionId: values.sessionId, status: values.status ?? "pending" })
    .returning({ id: schema.bookings.id });
  if (values.seatIds.length > 0) {
    await db.insert(schema.bookingSeats).values(
      values.seatIds.map((seatId) => ({ bookingId: id, sessionId: values.sessionId, seatId, priceCents: 3000 })),
    );
  }
  return id;
}

/** Inserts a booking with explicit per-seat ticket types and prices. */
export async function insertBookingWithPrices(
  db: Db,
  values: {
    userId: string;
    sessionId: string;
    seats: { seatId: string; ticketType?: "full" | "half"; priceCents: number }[];
    status?: string;
  },
): Promise<string> {
  const [{ id }] = await db
    .insert(schema.bookings)
    .values({ userId: values.userId, sessionId: values.sessionId, status: values.status ?? "pending" })
    .returning({ id: schema.bookings.id });
  if (values.seats.length > 0) {
    await db.insert(schema.bookingSeats).values(
      values.seats.map((seat) => ({
        bookingId: id,
        sessionId: values.sessionId,
        seatId: seat.seatId,
        ticketType: seat.ticketType ?? "full",
        priceCents: seat.priceCents,
      })),
    );
  }
  return id;
}

/** Moves the booking's deadline into the past, as if its 10 minutes had elapsed. */
export async function expireDeadlineOf(db: Db, bookingId: string): Promise<void> {
  await db
    .update(schema.bookings)
    .set({ expiresAt: sql`now() - interval '1 minute'` })
    .where(eq(schema.bookings.id, bookingId));
}

/** Backdates the booking's creation (and deadline) by the given hours. */
export async function backdateBooking(db: Db, bookingId: string, hours: number): Promise<void> {
  await db
    .update(schema.bookings)
    .set({
      createdAt: sql`now() - make_interval(hours => ${hours})`,
      expiresAt: sql`now() - make_interval(hours => ${hours}) + interval '10 minutes'`,
    })
    .where(eq(schema.bookings.id, bookingId));
}

/**
 * Backdates only `created_at`, leaving `expires_at` untouched (still in the
 * future): the state of a pending booking right before the backfill migration.
 */
export async function backdateCreationOnly(db: Db, bookingId: string, hours: number): Promise<void> {
  await db
    .update(schema.bookings)
    .set({ createdAt: sql`now() - make_interval(hours => ${hours})` })
    .where(eq(schema.bookings.id, bookingId));
}

let nextRecordedPaymentSeq = 1;

/** Records a Mercado Pago payment row for the booking (e.g. `in_process` = payment in flight). */
export async function recordPayment(
  db: Db,
  bookingId: string,
  status: string,
  overrides: {
    id?: string;
    externalPaymentId?: string | null;
    statusDetail?: string | null;
    amountCents?: number;
  } = {},
): Promise<string> {
  const attemptId = overrides.id ?? randomUUID();
  const externalPaymentId =
    overrides.externalPaymentId !== undefined
      ? overrides.externalPaymentId
      : `mp-${bookingId}-${nextRecordedPaymentSeq++}`;
  await db.insert(schema.payments).values({
    id: attemptId,
    bookingId,
    externalPaymentId,
    status,
    statusDetail: overrides.statusDetail ?? null,
    amountCents: overrides.amountCents ?? 3000,
  });
  return attemptId;
}

export async function readBooking(db: Db, bookingId: string): Promise<schema.Booking> {
  const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
  return booking;
}

export async function readPayment(db: Db, bookingId: string): Promise<schema.Payment | undefined> {
  const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, bookingId));
  return payment;
}

export async function readPaymentAttempt(db: Db, attemptId: string): Promise<schema.Payment | undefined> {
  const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, attemptId));
  return payment;
}

export async function readPaymentsOfBooking(db: Db, bookingId: string): Promise<schema.Payment[]> {
  return db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.bookingId, bookingId))
    .orderBy(asc(schema.payments.createdAt));
}

export async function readPaymentEvents(db: Db, bookingId: string): Promise<schema.PaymentEvent[]> {
  return db
    .select()
    .from(schema.paymentEvents)
    .where(eq(schema.paymentEvents.bookingId, bookingId))
    .orderBy(asc(schema.paymentEvents.createdAt));
}

export async function seatIdsOf(db: Db, bookingId: string): Promise<string[]> {
  const rows = await db
    .select({ seatId: schema.bookingSeats.seatId })
    .from(schema.bookingSeats)
    .where(eq(schema.bookingSeats.bookingId, bookingId));
  return rows.map((row) => row.seatId);
}

/** `expires_at - created_at` in seconds, as computed by Postgres. */
export async function deadlineWindowSeconds(db: Db, bookingId: string): Promise<number> {
  const [row] = await db
    .select({ seconds: sql<string>`extract(epoch from ${schema.bookings.expiresAt} - ${schema.bookings.createdAt})` })
    .from(schema.bookings)
    .where(eq(schema.bookings.id, bookingId));
  return Number(row.seconds);
}

/**
 * Deletes payment_events and payments of the given sessions' bookings.
 * `payment_events` has an append-only row trigger, so test cleanup disables
 * row triggers for the cleanup transaction only via `session_replication_role = replica`.
 */
export async function deletePaymentsOfSessions(db: Db, sessionIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const bookingIds = tx
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(inArray(schema.bookings.sessionId, sessionIds));
    await tx.delete(schema.paymentEvents).where(inArray(schema.paymentEvents.bookingId, bookingIds));
    await tx.delete(schema.payments).where(inArray(schema.payments.bookingId, bookingIds));
  });
}

/**
 * Re-runs the backfill statement of the expires_at migration, scoped to one
 * booking so parallel suites sharing the DB are left alone.
 */
export async function runExpiresAtBackfillFor(db: Db, bookingId: string): Promise<void> {
  const migrationsDir = join(__dirname, "../../drizzle");
  const file = readdirSync(migrationsDir).find((name) => name.startsWith("0003_") && name.endsWith(".sql"));
  if (!file) throw new Error("0003 migration not found");
  const backfill = readFileSync(join(migrationsDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim().replace(/;$/, ""))
    .find((statement) => statement.startsWith("UPDATE"));
  if (!backfill) throw new Error("Backfill UPDATE not found in the 0003 migration");
  await db.execute(sql.raw(`${backfill} WHERE "id" = '${bookingId}'`));
}

export interface MercadoPagoMocks {
  payment: { create: jest.Mock; get: jest.Mock };
}

/** The stubbed Mercado Pago client wired by startGuestFlowApp. */
export function mercadoPagoMocks(app: NestFastifyApplication): MercadoPagoMocks {
  return { payment: app.get(PAYMENT_CLIENT) };
}

let nextPaymentId = Math.floor(Date.now() / 1000);

export interface WebhookPaymentOverrides {
  paymentId?: number;
  statusDetail?: string;
  attemptId?: string;
  transactionAmount?: number;
}

/** Makes Mercado Pago report a payment with the given status for the booking, then delivers the webhook. */
export async function deliverPaymentWebhook(
  app: NestFastifyApplication,
  mocks: MercadoPagoMocks,
  bookingId: string,
  status: string,
  paymentIdOrOverrides?: number | WebhookPaymentOverrides,
): Promise<number> {
  const overrides: WebhookPaymentOverrides =
    typeof paymentIdOrOverrides === "number"
      ? { paymentId: paymentIdOrOverrides }
      : (paymentIdOrOverrides ?? {});
  const paymentId = overrides.paymentId ?? nextPaymentId++;

  mocks.payment.get.mockResolvedValue({
    id: paymentId,
    status,
    status_detail: overrides.statusDetail ?? null,
    external_reference: bookingId,
    transaction_amount: overrides.transactionAmount ?? 30,
    ...(overrides.attemptId ? { metadata: { attempt_id: overrides.attemptId } } : {}),
  });
  const response = await app.inject({
    method: "POST",
    url: "/payments/webhook",
    payload: { type: "payment", data: { id: String(paymentId) } },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Webhook failed with ${response.statusCode}: ${response.body}`);
  }
  return paymentId;
}

/** Delivers a legacy IPN notification in `{ topic: "payment", resource: "<id>" }` body shape. */
export async function deliverLegacyIpnBodyWebhook(
  app: NestFastifyApplication,
  mocks: MercadoPagoMocks,
  bookingId: string,
  status: string,
  paymentId = nextPaymentId++,
): Promise<number> {
  mocks.payment.get.mockResolvedValue({
    id: paymentId,
    status,
    external_reference: bookingId,
    transaction_amount: 30,
  });
  const response = await app.inject({
    method: "POST",
    url: "/payments/webhook",
    payload: { topic: "payment", resource: String(paymentId) },
  });
  if (response.statusCode !== 200) {
    throw new Error(`IPN body webhook failed with ${response.statusCode}: ${response.body}`);
  }
  return paymentId;
}

/** Delivers a legacy IPN notification in `?topic=payment&id=<id>` query-only shape. */
export async function deliverLegacyIpnQueryWebhook(
  app: NestFastifyApplication,
  mocks: MercadoPagoMocks,
  bookingId: string,
  status: string,
  paymentId = nextPaymentId++,
): Promise<number> {
  mocks.payment.get.mockResolvedValue({
    id: paymentId,
    status,
    external_reference: bookingId,
    transaction_amount: 30,
  });
  const response = await app.inject({
    method: "POST",
    url: `/payments/webhook?topic=payment&id=${paymentId}`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`IPN query webhook failed with ${response.statusCode}: ${response.body}`);
  }
  return paymentId;
}

export interface WarningLog {
  /** Warnings logged so far that mention the given text (e.g. a booking id). */
  mentioning: (text: string) => string[];
  restore: () => void;
}

/** Records every Nest Logger warning (muted from the test output); reads keep working after restore. */
export function captureWarnings(): WarningLog {
  const messages: string[] = [];
  const spy = jest.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
    messages.push(String(message));
  });
  return {
    mentioning: (text) => messages.filter((message) => message.includes(text)),
    restore: () => spy.mockRestore(),
  };
}

/** Waits a bit so late WebSocket events (if any) have a chance to arrive before counting them. */
export function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function attemptPaymentEventsUpdate(db: Db, eventId: string): Promise<void> {
  try {
    await db
      .update(schema.paymentEvents)
      .set({ type: "tampered" })
      .where(eq(schema.paymentEvents.id, eventId));
  } catch (err) {
    throw err instanceof Error && err.cause instanceof Error ? err.cause : err;
  }
}

export async function attemptPaymentEventsDelete(db: Db, eventId: string): Promise<void> {
  try {
    await db.delete(schema.paymentEvents).where(eq(schema.paymentEvents.id, eventId));
  } catch (err) {
    throw err instanceof Error && err.cause instanceof Error ? err.cause : err;
  }
}

/** Forces `BookingService.confirmPaidBooking` to throw once inside `tx2`, then restores it. */
export function failBookingConfirmationOnce(app: NestFastifyApplication): () => void {
  const bookingService = app.get(BookingService);
  const spy = jest.spyOn(bookingService, "confirmPaidBooking").mockImplementationOnce(async () => {
    throw new Error("Simulated failure inside tx2");
  });
  return () => spy.mockRestore();
}
