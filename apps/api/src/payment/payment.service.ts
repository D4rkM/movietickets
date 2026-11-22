import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Payment } from "mercadopago";
import {
  assertBookingNotExpired,
  BookingNotPendingException,
} from "../booking/booking-expired.exception";
import { pastDeadline } from "../booking/booking-lock";
import { BookingService } from "../booking/booking.service";
import { ProviderRefund, RefundDbTransaction, RefundService } from "../refund/refund.service";
import { DRIZZLE } from "../db/drizzle.module";
import { isUniqueViolation } from "../db/pg-errors";
import { BusinessMetrics } from "../telemetry/business-metrics";
import { setActiveSpanAttributes } from "../telemetry/spans";
import * as schema from "../db/schema";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { extractProviderErrorCode, extractProviderHttpStatus } from "../mercadopago/mercadopago-errors";
import { PAYMENT_CLIENT } from "../mercadopago/mercadopago.providers";
import {
  AttemptIdConflictException,
  PaymentInProgressException,
  PaymentProviderTimeoutException,
  PaymentRequestInvalidException,
} from "./payment.exceptions";
import {
  buildPaymentEventPayload,
  buildPaymentRequest,
  calculateBookingAmountCents,
  canTransitionPaymentStatus,
  CENTS_PER_UNIT,
  formatBookingDescription,
  formatBookingSeatLabel,
   PaymentEventSource,
  paymentStatusMessage,
  paymentStatusUpdateGuard,
  STALE_CREATED_ATTEMPT_MINUTES,
} from "./payment.helpers";

export interface MercadoPagoNotification {
  // Webhooks v2 (Orders API / newer apps) shape.
  type?: string;
  data?: { id?: string | number };
  // Legacy IPN shape: sent as `topic`/`resource` in the JSON body and/or as
  // `?topic=...&id=...` query params with no body at all.
  topic?: string;
  resource?: string;
}

export interface MercadoPagoWebhookQuery {
  topic?: string;
  id?: string;
}

export interface PaymentSummarySeat {
  seatId: string;
  label: string;
  ticketType: string;
  priceCents: number;
}

export interface PaymentSummaryResult {
  bookingId: string;
  status: string;
  expiresAt: string;
  amountCents: number;
  currency: "BRL";
  description: string;
  seats: PaymentSummarySeat[];
}

export interface PaymentAttemptResult {
  attemptId: string;
  paymentId: string | null;
  status: string;
  statusDetail: string | null;
  message: string;
  bookingStatus: string;
}

export interface PaymentAttemptSnapshot {
  id: string | null;
  externalPaymentId: string | null;
  status: string;
  statusDetail?: string | null;
  amountCents: number;
  installments?: number | null;
  paymentMethodId?: string | null;
  /** `refunds[]` of the re-fetched Mercado Pago payment (webhook only). */
  refunds?: ProviderRefund[];
}

type DbTransaction = RefundDbTransaction;

const SILENT_NON_APPROVED_STATUSES = new Set([
  "rejected",
  "cancelled",
  "in_process",
  "pending",
]);

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
  private readonly logger = new Logger(PaymentService.name);
  private readonly publicApiUrl: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: Payment,
    private readonly bookingService: BookingService,
    private readonly refundService: RefundService,
    config: ConfigService,
    private readonly metrics: BusinessMetrics,
  ) {
    this.publicApiUrl = config.get<string>("PUBLIC_API_URL", "http://localhost:3000");
  }

  async getPaymentSummary(bookingId: string, userId: string): Promise<PaymentSummaryResult> {
    const booking = await this.db.query.bookings.findFirst({
      where: eq(schema.bookings.id, bookingId),
      with: { session: { with: { movie: true } }, seats: { with: { seat: true } } },
      extras: (table) => ({ pastDeadline: pastDeadline(table.expiresAt).as("past_deadline") }),
    });
    if (!booking || booking.userId !== userId) {
      throw new NotFoundException("Reserva não encontrada");
    }
    assertBookingNotExpired(booking);
    if (booking.status !== "pending") {
      throw new BookingNotPendingException(booking.status);
    }

    const amountCents = calculateBookingAmountCents(booking.seats);
    const description = formatBookingDescription(booking.session.movie.title, booking.seats);

    return {
      bookingId: booking.id,
      status: booking.status,
      expiresAt: booking.expiresAt.toISOString(),
      amountCents,
      currency: "BRL",
      description,
      seats: booking.seats.map((bookingSeat) => ({
        seatId: bookingSeat.seatId,
        label: formatBookingSeatLabel(bookingSeat.seat),
        ticketType: bookingSeat.ticketType,
        priceCents: bookingSeat.priceCents,
      })),
    };
  }

  async createPayment(
    bookingId: string,
    userId: string,
    dto: CreatePaymentDto,
  ): Promise<PaymentAttemptResult> {
    let tx1Result:
      | { kind: "replay_stored"; result: PaymentAttemptResult }
      | { kind: "call_mp"; amountCents: number; description: string };
    // Metric facts from tx1, emitted only once it committed.
    let abandonedAttempts = 0;
    let attemptCreated = false;

    try {
      tx1Result = await this.db.transaction(async (tx) => {
        // Serialize concurrent payment attempts for the same booking.
        const [lockedBooking] = await tx
          .select({
            id: schema.bookings.id,
            userId: schema.bookings.userId,
            sessionId: schema.bookings.sessionId,
            status: schema.bookings.status,
            expiresAt: schema.bookings.expiresAt,
            pastDeadline: pastDeadline(schema.bookings.expiresAt),
          })
          .from(schema.bookings)
          .where(eq(schema.bookings.id, bookingId))
          .for("update");

        if (!lockedBooking || lockedBooking.userId !== userId) {
          throw new NotFoundException("Reserva não encontrada");
        }

        const [existingAttempt] = await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.id, dto.attemptId));

        if (existingAttempt) {
          if (existingAttempt.bookingId !== bookingId) {
            throw new AttemptIdConflictException();
          }
          if (existingAttempt.status !== "created") {
            if (existingAttempt.status === "request_failed") {
              throw new PaymentRequestInvalidException();
            }
            return {
              kind: "replay_stored" as const,
              result: {
                attemptId: existingAttempt.id,
                paymentId: existingAttempt.externalPaymentId ?? null,
                status: existingAttempt.status,
                statusDetail: existingAttempt.statusDetail ?? null,
                message: paymentStatusMessage(existingAttempt.status, existingAttempt.statusDetail),
                bookingStatus: lockedBooking.status,
              },
            };
          }
        }

        assertBookingNotExpired(lockedBooking);
        if (lockedBooking.status !== "pending") {
          throw new BookingNotPendingException(lockedBooking.status);
        }

        if (!existingAttempt) {
          // Abandon `created` attempts older than 2 minutes so a lost client doesn't lock out new attempts forever.
          const staleCreated = await tx
            .update(schema.payments)
            .set({ status: "abandoned", updatedAt: sql`now()` })
            .where(
              and(
                eq(schema.payments.bookingId, bookingId),
                eq(schema.payments.status, "created"),
                lte(
                  schema.payments.createdAt,
                  sql`now() - make_interval(mins => ${STALE_CREATED_ATTEMPT_MINUTES})`,
                ),
              ),
            )
            .returning({ id: schema.payments.id, amountCents: schema.payments.amountCents });
          abandonedAttempts = staleCreated.length;

          for (const stale of staleCreated) {
            await tx.insert(schema.paymentEvents).values({
              bookingId,
              paymentId: stale.id,
              type: "attempt_abandoned",
              payload: buildPaymentEventPayload({
                attempt_id: stale.id,
                status: "abandoned",
                amount_cents: stale.amountCents,
                source: "sync",
              }),
            });
          }

          const [inProgress] = await tx
            .select({ id: schema.payments.id })
            .from(schema.payments)
            .where(
              and(
                eq(schema.payments.bookingId, bookingId),
                inArray(schema.payments.status, ["pending", "in_process", "created"]),
              ),
            )
            .limit(1);

          if (inProgress) {
            throw new PaymentInProgressException();
          }
        }

        const bookingWithDetails = await tx.query.bookings.findFirst({
          where: eq(schema.bookings.id, bookingId),
          with: { session: { with: { movie: true } }, seats: { with: { seat: true } } },
        });
        if (!bookingWithDetails) {
          throw new NotFoundException("Reserva não encontrada");
        }

        const amountCents = calculateBookingAmountCents(bookingWithDetails.seats);
        const description = formatBookingDescription(
          bookingWithDetails.session.movie.title,
          bookingWithDetails.seats,
        );

        if (!existingAttempt) {
          await tx.insert(schema.payments).values({
            id: dto.attemptId,
            bookingId,
            provider: "mercado_pago",
            status: "created",
            amountCents,
            installments: dto.installments,
            paymentMethodId: dto.paymentMethodId,
          });

          await tx.insert(schema.paymentEvents).values({
            bookingId,
            paymentId: dto.attemptId,
            type: "attempt_created",
            payload: buildPaymentEventPayload({
              attempt_id: dto.attemptId,
              status: "created",
              amount_cents: amountCents,
              installments: dto.installments,
              payment_method_id: dto.paymentMethodId,
              source: "sync",
            }),
          });
          attemptCreated = true;
        }

        return { kind: "call_mp" as const, amountCents, description };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AttemptIdConflictException();
      }
      throw err;
    }
    if (abandonedAttempts > 0) this.metrics.paymentStatusChanged("abandoned", "sync", abandonedAttempts);
    if (attemptCreated) this.metrics.paymentAttemptCreated();

    if (tx1Result.kind === "replay_stored") {
      return tx1Result.result;
    }

    const request = buildPaymentRequest({
      booking: {
        id: bookingId,
        amountCents: tx1Result.amountCents,
        description: tx1Result.description,
      },
      dto,
      publicApiUrl: this.publicApiUrl,
    });

    let mpPayment: Awaited<ReturnType<Payment["create"]>>;
    try {
      mpPayment = await this.paymentClient.create(request);
    } catch (err) {
      const providerStatus = extractProviderHttpStatus(err);
      if (providerStatus === 409) {
        throw new PaymentInProgressException();
      }
      if (providerStatus !== undefined && providerStatus >= 400 && providerStatus < 500) {
        const errorCode = extractProviderErrorCode(err, providerStatus);
        const failedRows = await this.db.transaction(async (tx) => {
          const failed = await tx
            .update(schema.payments)
            .set({ status: "request_failed", updatedAt: sql`now()` })
            .where(eq(schema.payments.id, dto.attemptId))
            .returning({ id: schema.payments.id });
          await tx.insert(schema.paymentEvents).values({
            bookingId,
            paymentId: dto.attemptId,
            type: "mp_request_failed",
            payload: buildPaymentEventPayload({
              attempt_id: dto.attemptId,
              status: "request_failed",
              amount_cents: tx1Result.amountCents,
              installments: dto.installments,
              payment_method_id: dto.paymentMethodId,
              source: "sync",
              error_code: errorCode,
            }),
          });
          return failed.length;
        });
        this.metrics.paymentStatusChanged("request_failed", "sync", failedRows);
        this.metrics.paymentProviderError("request_invalid");
        throw new PaymentRequestInvalidException();
      }
      this.metrics.paymentProviderError("timeout");
      throw new PaymentProviderTimeoutException();
    }

    const externalPaymentId = mpPayment.id != null ? String(mpPayment.id) : null;
    const status = mpPayment.status ?? "unknown";
    const statusDetail = mpPayment.status_detail ?? null;
    const installments = mpPayment.installments ?? dto.installments;
    const paymentMethodId = mpPayment.payment_method_id ?? dto.paymentMethodId;
    // status_detail is a long, changing Mercado Pago list: span attribute only, never a metric label.
    setActiveSpanAttributes({ "payment.status": status, "payment.status_detail": statusDetail });

    const { notify, bookingStatus, statusChanged } = await this.db.transaction(async (tx) => {
      const changedRows = await tx
        .update(schema.payments)
        .set({
          externalPaymentId,
          status,
          statusDetail,
          installments,
          paymentMethodId,
          updatedAt: sql`now()`,
        })
        .where(and(eq(schema.payments.id, dto.attemptId), paymentStatusUpdateGuard(status)))
        .returning({ id: schema.payments.id });

      await tx.insert(schema.paymentEvents).values({
        bookingId,
        paymentId: dto.attemptId,
        type: "mp_response",
        payload: buildPaymentEventPayload({
          attempt_id: dto.attemptId,
          mp_payment_id: externalPaymentId,
          status,
          status_detail: statusDetail,
          amount_cents: tx1Result.amountCents,
          installments,
          payment_method_id: paymentMethodId,
          source: "sync",
        }),
      });

      const notifyFn = await this.applyPaymentStatus(
        tx,
        bookingId,
        {
          id: dto.attemptId,
          externalPaymentId,
          status,
          statusDetail,
          amountCents: tx1Result.amountCents,
          installments,
          paymentMethodId,
        },
        "sync",
      );

      const [currentBooking] = await tx
        .select({ status: schema.bookings.status })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, bookingId));

      return {
        notify: notifyFn,
        bookingStatus: currentBooking?.status ?? "pending",
        statusChanged: changedRows.length > 0,
      };
    });

    if (statusChanged) this.metrics.paymentStatusChanged(status, "sync");
    await notify();

    return {
      attemptId: dto.attemptId,
      paymentId: externalPaymentId,
      status,
      statusDetail,
      message: paymentStatusMessage(status, statusDetail),
      bookingStatus,
    };
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

    const externalPaymentId = String(payment.id);
    const status = payment.status ?? "unknown";
    const statusDetail = payment.status_detail ?? null;
    const amountCents = Math.round((payment.transaction_amount ?? 0) * CENTS_PER_UNIT);
    const installments = payment.installments ?? null;
    const paymentMethodId = payment.payment_method_id ?? null;
    const metadataAttemptId =
      typeof payment.metadata?.attempt_id === "string" ? payment.metadata.attempt_id : undefined;
    setActiveSpanAttributes({ "payment.status": status, "payment.status_detail": statusDetail });
    // Set inside the transaction, read after it committed (metric emission).
    let statusChanged = false;

    const notify = await this.db.transaction(async (tx) => {
      // 1. Normal path: match the attempt row by external_payment_id recorded in tx2.
      let [attempt] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.externalPaymentId, externalPaymentId));

      if (attempt) {
        if (canTransitionPaymentStatus(attempt.status, status)) {
          const updated = await tx
            .update(schema.payments)
            .set({
              status,
              statusDetail,
              amountCents,
              installments: installments ?? attempt.installments,
              paymentMethodId: paymentMethodId ?? attempt.paymentMethodId,
              updatedAt: sql`now()`,
            })
            .where(and(eq(schema.payments.id, attempt.id), paymentStatusUpdateGuard(status)))
            .returning({ id: schema.payments.id });
          statusChanged = updated.length > 0 && attempt.status !== status;
          attempt = {
            ...attempt,
            status,
            statusDetail,
            amountCents,
            installments: installments ?? attempt.installments,
            paymentMethodId: paymentMethodId ?? attempt.paymentMethodId,
          };
        }
      } else if (metadataAttemptId) {
        // 2. Reconcile when tx2 didn't persist external_payment_id: match by metadata.attempt_id.
        [attempt] = await tx
          .select()
          .from(schema.payments)
          .where(
            and(
              eq(schema.payments.id, metadataAttemptId),
              eq(schema.payments.bookingId, bookingId),
            ),
          );
        if (attempt && canTransitionPaymentStatus(attempt.status, status)) {
          const updated = await tx
            .update(schema.payments)
            .set({
              externalPaymentId,
              status,
              statusDetail,
              amountCents,
              installments: installments ?? attempt.installments,
              paymentMethodId: paymentMethodId ?? attempt.paymentMethodId,
              updatedAt: sql`now()`,
            })
            .where(and(eq(schema.payments.id, attempt.id), paymentStatusUpdateGuard(status)))
            .returning({ id: schema.payments.id });
          statusChanged = updated.length > 0 && attempt.status !== status;
          attempt = {
            ...attempt,
            externalPaymentId,
            status,
            statusDetail,
            amountCents,
            installments: installments ?? attempt.installments,
            paymentMethodId: paymentMethodId ?? attempt.paymentMethodId,
          };
        }
      }

      if (!attempt) {
        // 3. Legacy Preference payment (or payment without a pre-existing attempt row).
        const [inserted] = await tx
          .insert(schema.payments)
          .values({
            bookingId,
            externalPaymentId,
            status,
            statusDetail,
            amountCents,
            installments,
            paymentMethodId,
          })
          .onConflictDoUpdate({
            target: schema.payments.externalPaymentId,
            targetWhere: sql`${schema.payments.externalPaymentId} IS NOT NULL`,
            set: {
              status,
              statusDetail,
              amountCents,
              installments,
              paymentMethodId,
              updatedAt: sql`now()`,
            },
            setWhere: paymentStatusUpdateGuard(status),
          })
          .returning();
        // No row matched by external_payment_id above, so a returned row is a new
        // payment (or one inserted concurrently and updated by the upsert).
        statusChanged = inserted !== undefined;

        attempt =
          inserted ??
          (
            await tx
              .select()
              .from(schema.payments)
              .where(eq(schema.payments.externalPaymentId, externalPaymentId))
          )[0];
      }

      await tx.insert(schema.paymentEvents).values({
        bookingId,
        paymentId: attempt?.id ?? null,
        type: "webhook_received",
        payload: buildPaymentEventPayload({
          attempt_id: attempt?.id ?? metadataAttemptId ?? null,
          mp_payment_id: externalPaymentId,
          status,
          status_detail: statusDetail,
          amount_cents: amountCents,
          installments: installments ?? attempt?.installments ?? null,
          payment_method_id: paymentMethodId ?? attempt?.paymentMethodId ?? null,
          source: "webhook",
        }),
      });

      return this.applyPaymentStatus(
        tx,
        bookingId,
        {
          id: attempt?.id ?? null,
          externalPaymentId,
          status,
          statusDetail,
          amountCents,
          installments: installments ?? attempt?.installments ?? null,
          paymentMethodId: paymentMethodId ?? attempt?.paymentMethodId ?? null,
          refunds: payment.refunds ?? [],
        },
        "webhook",
      );
    });

    if (statusChanged) this.metrics.paymentStatusChanged(status, "webhook");
    await notify();
  }

  /**
   * Shared effect of a Mercado Pago payment status on the booking, used by both
   * the synchronous `Payment.create` response (`tx2`) and the webhook.
   * Returns a post-commit notification callback (broadcast + confirmation email).
   *
   * Refunds (docs/flows/refund/spec.md): `refunded`, or `approved` still
   * carrying refunds (one in process or rejected), go to
   * `RefundService.applyRefundedPayment`; `approved/partially_refunded` (a
   * partial refund made outside the API) is only logged.
   */
  async applyPaymentStatus(
    tx: DbTransaction,
    bookingId: string,
    paymentRow: PaymentAttemptSnapshot,
    source: PaymentEventSource = "sync",
  ): Promise<() => Promise<void>> {
    if (paymentRow.status === "approved" && paymentRow.statusDetail === "partially_refunded") {
      this.logger.warn(
        `Partial refund made outside the API, ignored: bookingId=${bookingId} ` +
          `paymentId=${paymentRow.id ?? "unknown"} externalPaymentId=${paymentRow.externalPaymentId ?? "unknown"}`,
      );
      return async () => undefined;
    }

    const refunds = paymentRow.refunds ?? [];
    if (paymentRow.status === "refunded" || (paymentRow.status === "approved" && refunds.length > 0)) {
      return this.refundService.applyRefundedPayment(tx, {
        bookingId,
        paymentId: paymentRow.id,
        paymentStatus: paymentRow.status,
        amountCents: paymentRow.amountCents,
        refunds,
      });
    }

    if (paymentRow.status === "approved") {
      const confirmation = await this.bookingService.confirmPaidBooking(
        bookingId,
        {
          externalPaymentId: paymentRow.externalPaymentId ?? "unknown",
          amountCents: paymentRow.amountCents,
        },
        tx,
        source === "webhook" ? "payment_webhook" : "payment_sync",
      );
      if (confirmation.confirmed) {
        await tx.insert(schema.paymentEvents).values({
          bookingId,
          paymentId: paymentRow.id,
          type: "booking_confirmed",
          payload: buildPaymentEventPayload({
            attempt_id: paymentRow.id,
            mp_payment_id: paymentRow.externalPaymentId,
            status: paymentRow.status,
            status_detail: paymentRow.statusDetail ?? null,
            amount_cents: paymentRow.amountCents,
            installments: paymentRow.installments ?? null,
            payment_method_id: paymentRow.paymentMethodId ?? null,
            source,
          }),
        });
      }
      return confirmation.notify;
    }

    if (SILENT_NON_APPROVED_STATUSES.has(paymentRow.status)) {
      return async () => undefined;
    }

    this.logger.warn(
      `Unhandled payment status "${paymentRow.status}": bookingId=${bookingId} ` +
        `paymentId=${paymentRow.id ?? "unknown"} externalPaymentId=${paymentRow.externalPaymentId ?? "unknown"}`,
    );
    return async () => undefined;
  }
}
