import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Payment, Preference } from "mercadopago";
import { BookingService } from "../booking/booking.service";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { PAYMENT_CLIENT, PREFERENCE_CLIENT } from "./mercadopago.providers";

export interface MercadoPagoNotification {
  type?: string;
  data?: { id?: string | number };
}

export interface CheckoutResult {
  checkoutUrl: string;
}

const CENTS_PER_UNIT = 100;

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
          success: `${this.webUrl}/checkout/retorno`,
          failure: `${this.webUrl}/checkout/retorno`,
          pending: `${this.webUrl}/checkout/retorno`,
        },
        auto_return: "approved",
      },
    });

    return { checkoutUrl: preference.init_point! };
  }

  async handleWebhook(notification: MercadoPagoNotification): Promise<void> {
    if (notification.type !== "payment" || !notification.data?.id) return;

    // Status comes from re-fetching the payment, never from the webhook body.
    const payment = await this.paymentClient.get({ id: Number(notification.data.id) });
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
      });

    if (payment.status === "approved") {
      await this.bookingService.confirmPaidBooking(bookingId);
    }
  }
}
