import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Payment, Preference } from "mercadopago";
import { BookingService } from "../booking/booking.service";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { PAYMENT_CLIENT, PREFERENCE_CLIENT } from "./mercadopago.providers";

export interface MercadoPagoNotification {
  // Webhooks v2 (Orders API / newer apps) shape.
  type?: string;
  data?: { id?: string | number };
  // Preferences API IPN shape: same info, sent as `topic`/`resource` in the
  // JSON body and/or as `?topic=...&id=...` query params with no body at all.
  topic?: string;
  resource?: string;
}

export interface MercadoPagoWebhookQuery {
  topic?: string;
  id?: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
}

const CENTS_PER_UNIT = 100;
// MP uses "cancelled" for payments whose deadline passed before completion
// (what the product calls "expirado"); "rejected" covers a declined payment.
const FAILED_PAYMENT_STATUSES = new Set(["rejected", "cancelled"]);

function extractPaymentId(
  body: MercadoPagoNotification = {},
  query: MercadoPagoWebhookQuery = {},
): string | undefined {
  if (body.type === "payment" && body.data?.id) return String(body.data.id);
  if (body.topic === "payment" && body.resource) return body.resource;
  if (query.topic === "payment" && query.id) return query.id;
  return undefined;
}

@Injectable()
export class PaymentService {
  private readonly webUrl: string;
  private readonly publicApiUrl: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(PREFERENCE_CLIENT) private readonly preferenceClient: Preference,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: Payment,
    private readonly bookingService: BookingService,
    config: ConfigService,
  ) {
    this.webUrl = config.get<string>("WEB_URL", "http://localhost:5173");
    this.publicApiUrl = config.get<string>("PUBLIC_API_URL", "http://localhost:3000");
  }

  async createCheckout(bookingId: string, userId: string): Promise<CheckoutResult> {
    const booking = await this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
      with: { session: { with: { movie: true } }, seats: { with: { seat: true } } },
    });
    if (!booking || booking.userId !== userId) {
      throw new NotFoundException("Reserva não encontrada");
    }
    if (booking.status !== "pending") {
      throw new ConflictException(`Reserva já está com status "${booking.status}"`);
    }

    const successUrl = `${this.webUrl}/checkout/retorno`;
    // Mercado Pago requires back_urls.success to be https before it accepts auto_return,
    // so dev's http://localhost WEB_URL has to skip it (user returns via a manual link instead).
    const isHttps = successUrl.startsWith("https://");

    const preference = await this.preferenceClient.create({
      body: {
        items: booking.seats.map((bookingSeat) => ({
          id: bookingSeat.seatId,
          title: `${booking.session.movie.title} - ${bookingSeat.seat.rowLabel}${bookingSeat.seat.seatNumber}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: bookingSeat.priceCents / CENTS_PER_UNIT,
        })),
        external_reference: booking.id,
        notification_url: `${this.publicApiUrl}/payments/webhook`,
        back_urls: {
          success: successUrl,
          failure: `${this.webUrl}/checkout/retorno`,
          pending: `${this.webUrl}/checkout/retorno`,
        },
        ...(isHttps ? { auto_return: "approved" as const } : {}),
      },
    });

    return { checkoutUrl: preference.init_point! };
  }

  async handleWebhook(
    notification: MercadoPagoNotification = {},
    query: MercadoPagoWebhookQuery = {},
  ): Promise<void> {
    const paymentId = extractPaymentId(notification, query);
    if (!paymentId) return;

    // Status comes from re-fetching the payment, never from the webhook notification.
    const payment = await this.paymentClient.get({ id: Number(paymentId) });
    const bookingId = payment.external_reference;
    if (!bookingId) return;

    const amountCents = Math.round((payment.transaction_amount ?? 0) * CENTS_PER_UNIT);
    await this.db
      .insert(schema.payments)
      .values({
        bookingId,
        externalPaymentId: String(payment.id),
        status: payment.status ?? "unknown",
        amountCents,
      })
      .onConflictDoUpdate({
        target: schema.payments.bookingId,
        set: { externalPaymentId: String(payment.id), status: payment.status ?? "unknown", amountCents },
        // A late/redelivered notification for an older payment attempt on the same booking must
        // never clobber a row that already recorded an approved payment.
        setWhere: sql`${schema.payments.status} <> 'approved'`,
      });

    if (payment.status === "approved") {
      await this.bookingService.confirmPaidBooking(bookingId);
    } else if (payment.status && FAILED_PAYMENT_STATUSES.has(payment.status)) {
      await this.bookingService.releaseFailedPaymentBooking(bookingId);
    }
  }
}
