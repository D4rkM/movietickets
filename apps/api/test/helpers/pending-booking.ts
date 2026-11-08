import { Logger } from "@nestjs/common";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";
import { PAYMENT_CLIENT, PREFERENCE_CLIENT } from "../../src/payment/mercadopago.providers";
import { callAs } from "./guest-flow";

type Db = PostgresJsDatabase<typeof schema>;

/** POST /sessions/:id/book with full-price tickets for every seat. */
export function bookSeatsAs(app: NestFastifyApplication, token: string, sessionId: string, seatIds: string[]) {
  return callAs(app, token, "POST", `/sessions/${sessionId}/book`, {
    seats: seatIds.map((seatId) => ({ seatId, ticketType: "full" })),
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

export function checkoutAs(app: NestFastifyApplication, token: string, bookingId: string) {
  return callAs(app, token, "POST", `/bookings/${bookingId}/checkout`);
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

/** Records a Mercado Pago payment row for the booking (e.g. `in_process` = payment in flight). */
export async function recordPayment(db: Db, bookingId: string, status: string): Promise<void> {
  await db.insert(schema.payments).values({ bookingId, externalPaymentId: `mp-${bookingId}`, status, amountCents: 3000 });
}

export async function readBooking(db: Db, bookingId: string): Promise<schema.Booking> {
  const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
  return booking;
}

export async function readPayment(db: Db, bookingId: string): Promise<schema.Payment | undefined> {
  const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, bookingId));
  return payment;
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

/** Deletes payments of the given sessions' bookings (cinema fixture cleanup doesn't know about payments). */
export async function deletePaymentsOfSessions(db: Db, sessionIds: string[]): Promise<void> {
  const bookingIds = db
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(inArray(schema.bookings.sessionId, sessionIds));
  await db.delete(schema.payments).where(inArray(schema.payments.bookingId, bookingIds));
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
  preference: { create: jest.Mock };
  payment: { get: jest.Mock };
}

/** The stubbed Mercado Pago clients wired by startGuestFlowApp. */
export function mercadoPagoMocks(app: NestFastifyApplication): MercadoPagoMocks {
  return { preference: app.get(PREFERENCE_CLIENT), payment: app.get(PAYMENT_CLIENT) };
}

let nextPaymentId = Math.floor(Date.now() / 1000);

/** Makes Mercado Pago report a payment with the given status for the booking, then delivers the webhook. */
export async function deliverPaymentWebhook(
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
    payload: { type: "payment", data: { id: String(paymentId) } },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Webhook failed with ${response.statusCode}: ${response.body}`);
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
