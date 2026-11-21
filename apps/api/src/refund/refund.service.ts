import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Payment, PaymentRefund } from "mercadopago";
import { isPastCancellationDeadline } from "../booking/booking-lock";
import { BookingService } from "../booking/booking.service";
import { DRIZZLE } from "../db/drizzle.module";
import { isUniqueViolation } from "../db/pg-errors";
import * as schema from "../db/schema";
import { PAYMENT_CLIENT, REFUND_CLIENT } from "../mercadopago/mercadopago.providers";
import { NotificationService } from "../notification/notification.service";
import { buildPaymentEventPayload, CENTS_PER_UNIT, PaymentEventSource } from "../payment/payment.helpers";
import {
  BookingNotCancellableException,
  CancellationDeadlinePassedException,
  RefundInProgressException,
  RefundNotAllowedException,
  RefundProviderTimeoutException,
  RefundRejectedException,
  RefundRequestInvalidException,
} from "./refund.exceptions";
import { buildRefundRequest, classifyRefundProviderError } from "./refund.helpers";
import {
  CustomerRefundStatus,
  decideRefundTransition,
  normalizeProviderRefundStatus,
  RefundReason,
  STALE_REQUESTED_REFUND_MINUTES,
  toCustomerRefundStatus,
} from "./refund-status";

export type RefundDbTransaction = Pick<
  PostgresJsDatabase<typeof schema>,
  "select" | "insert" | "update" | "delete" | "query"
>;

/** The part of a Mercado Pago `RefundResponse` the refund flow reads. */
export interface ProviderRefund {
  id?: number | string | null;
  status?: string | null;
  amount?: number | null;
}

export interface CancelBookingResult {
  bookingId: string;
  status: string;
  refund: { id: string; status: CustomerRefundStatus; amountCents: number } | null;
}

export interface AdminRefundResult {
  bookingId: string;
  bookingStatus: string;
  refund: { id: string; status: string; amountCents: number } | null;
}

export interface RefundedPaymentContext {
  bookingId: string;
  /** Our `payments.id` of the attempt the webhook is about. */
  paymentId: string | null;
  /** Mercado Pago payment status, as re-fetched by the webhook. */
  paymentStatus: string;
  amountCents: number;
  refunds: ProviderRefund[];
}

export interface AppliedRefundStatus {
  refund: schema.Refund;
  bookingStatus: string;
  /** Post-commit side effects (seat broadcasts, refund email). */
  notify: () => Promise<void>;
}

type Notify = () => Promise<void>;

const noop: Notify = async () => undefined;

function combine(notifiers: Notify[]): Notify {
  return async () => {
    for (const notify of notifiers) {
      await notify();
    }
  };
}

/** `refunds.updated_at` older than the in-flight window: a `requested` row nobody is calling Mercado Pago for anymore. */
function staleRequestedRefund() {
  return sql<boolean>`${schema.refunds.updatedAt} <= now() - make_interval(mins => ${STALE_REQUESTED_REFUND_MINUTES})`;
}

/**
 * Refund commands: customer cancellation with refund, admin refund of a booking
 * under review, and the shared `applyRefundStatus` used by the synchronous
 * Mercado Pago response, the admin reconciliation and the webhook.
 *
 * Every flow follows the same tx1 → HTTP → tx2 shape as `createPayment`: the
 * `refunds` row (whose id is the idempotency key) is committed before calling
 * Mercado Pago, and no transaction is held open around the HTTP call.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(REFUND_CLIENT) private readonly refundClient: PaymentRefund,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: Payment,
    private readonly bookingService: BookingService,
    private readonly notificationService: NotificationService,
  ) {}

  /** `POST /bookings/:id/cancel`: cancels the owner's confirmed booking, refunding its approved payment in full. */
  async cancelWithRefund(bookingId: string, userId: string): Promise<CancelBookingResult> {
    const prepared = await this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select({
          id: schema.bookings.id,
          userId: schema.bookings.userId,
          status: schema.bookings.status,
          startsAt: schema.sessions.startsAt,
          dbNow: sql<Date>`now()`.mapWith(schema.sessions.startsAt),
        })
        .from(schema.bookings)
        .innerJoin(schema.sessions, eq(schema.sessions.id, schema.bookings.sessionId))
        .where(eq(schema.bookings.id, bookingId))
        .for("update", { of: schema.bookings });

      if (!booking || booking.userId !== userId) {
        throw new NotFoundException("Reserva não encontrada");
      }
      if (booking.status === "cancelled") {
        return { kind: "replay" as const, result: await this.currentCancellation(tx, bookingId) };
      }
      if (booking.status !== "confirmed") {
        throw new BookingNotCancellableException();
      }
      if (isPastCancellationDeadline(booking.startsAt, booking.dbNow)) {
        throw new CancellationDeadlinePassedException();
      }

      const payment = await this.findApprovedPayment(tx, bookingId);
      if (!payment) {
        // Confirmed without a real payment (mocked confirm route or seed): nothing to refund.
        const cancellation = await this.bookingService.cancelConfirmedBooking(tx, bookingId);
        await this.insertEvent(tx, bookingId, null, "booking_cancelled", { status: "cancelled", source: "sync" });
        return { kind: "cancelled_without_refund" as const, notify: cancellation.notify };
      }

      const refund = await this.requestRefundRow(tx, {
        bookingId,
        payment,
        reason: "customer_cancellation",
        requestedBy: userId,
        source: "sync",
      });
      return { kind: "call_provider" as const, refund, externalPaymentId: payment.externalPaymentId };
    });

    if (prepared.kind === "replay") {
      return prepared.result;
    }
    if (prepared.kind === "cancelled_without_refund") {
      await prepared.notify();
      return { bookingId, status: "cancelled", refund: null };
    }

    const applied = await this.callProviderAndApply(prepared.refund, prepared.externalPaymentId, "sync");
    return {
      bookingId,
      status: applied.bookingStatus,
      refund: {
        id: applied.refund.id,
        status: toCustomerRefundStatus(applied.refund.status),
        amountCents: applied.refund.amountCents,
      },
    };
  }

  /**
   * `POST /admin/bookings/:id/refund`: refunds a booking that is in the review
   * queue (`needs_refund_review`, or a `requested` refund stalled past the
   * in-flight window). An `in_process` refund is reconciled against Mercado
   * Pago instead of creating another one; a stalled one is retried with its key.
   */
  async requestAdminRefund(bookingId: string, adminId: string): Promise<AdminRefundResult> {
    const prepared = await this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select({ id: schema.bookings.id, needsRefundReview: schema.bookings.needsRefundReview })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, bookingId))
        .for("update");
      if (!booking) {
        throw new NotFoundException("Reserva não encontrada");
      }

      const [lastRefund] = await tx
        .select({ refund: schema.refunds, stale: staleRequestedRefund() })
        .from(schema.refunds)
        .where(eq(schema.refunds.bookingId, bookingId))
        .orderBy(desc(schema.refunds.createdAt))
        .limit(1);
      const stalled = lastRefund?.refund.status === "requested" && lastRefund.stale;

      if (!booking.needsRefundReview && !stalled) {
        throw new RefundNotAllowedException();
      }

      if (lastRefund?.refund.status === "in_process" || lastRefund?.refund.status === "requested") {
        if (lastRefund.refund.status === "requested" && !stalled) {
          throw new RefundInProgressException();
        }
        const [payment] = await tx
          .select({ externalPaymentId: schema.payments.externalPaymentId })
          .from(schema.payments)
          .where(eq(schema.payments.id, lastRefund.refund.paymentId));
        if (!payment?.externalPaymentId) {
          throw new RefundNotAllowedException();
        }
        return {
          kind: lastRefund.refund.status === "in_process" ? ("reconcile" as const) : ("call_provider" as const),
          refund: lastRefund.refund,
          externalPaymentId: payment.externalPaymentId,
        };
      }

      const payment = await this.findApprovedPayment(tx, bookingId);
      if (!payment) {
        throw new RefundNotAllowedException();
      }
      const refund = await this.requestRefundRow(tx, {
        bookingId,
        payment,
        reason: "expired_booking_review",
        requestedBy: adminId,
        source: "admin",
      });
      return { kind: "call_provider" as const, refund, externalPaymentId: payment.externalPaymentId };
    });

    const applied =
      prepared.kind === "reconcile"
        ? await this.reconcileRefund(prepared.refund, prepared.externalPaymentId)
        : await this.callProviderAndApply(prepared.refund, prepared.externalPaymentId, "admin");

    return {
      bookingId,
      bookingStatus: applied.bookingStatus,
      refund: { id: applied.refund.id, status: applied.refund.status, amountCents: applied.refund.amountCents },
    };
  }

  /**
   * Applies a Mercado Pago refund status to one `refunds` row, at most once:
   * the booking and refund rows are locked (booking first, same order as tx1)
   * and the status only moves along {@link decideRefundTransition}, so
   * concurrent callers (sync response, webhook, admin reconciliation) apply
   * each effect a single time. Returns the post-commit notifier.
   */
  async applyRefundStatus(
    tx: RefundDbTransaction,
    refundRef: { id: string; bookingId: string },
    providerRefund: ProviderRefund,
    source: PaymentEventSource,
  ): Promise<AppliedRefundStatus> {
    const [booking] = await tx
      .select({ id: schema.bookings.id, status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, refundRef.bookingId))
      .for("update");
    const [current] = await tx.select().from(schema.refunds).where(eq(schema.refunds.id, refundRef.id)).for("update");

    const nextStatus = normalizeProviderRefundStatus(providerRefund.status);
    const externalRefundId = providerRefund.id != null ? String(providerRefund.id) : null;
    const transition = decideRefundTransition(current.status, nextStatus);

    if (transition === "ignore") {
      if (!current.externalRefundId && externalRefundId && current.status === nextStatus) {
        await tx
          .update(schema.refunds)
          .set({ externalRefundId, updatedAt: sql`now()` })
          .where(eq(schema.refunds.id, current.id));
      }
      return { refund: current, bookingStatus: booking.status, notify: noop };
    }

    const [updated] = await tx
      .update(schema.refunds)
      .set({
        status: nextStatus,
        externalRefundId: current.externalRefundId ?? externalRefundId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.refunds.id, current.id), eq(schema.refunds.status, current.status)))
      .returning();

    const eventPayload = {
      attempt_id: updated.paymentId,
      refund_id: updated.id,
      mp_refund_id: updated.externalRefundId,
      refund_status: updated.status,
      amount_cents: updated.amountCents,
      reason: updated.reason,
      source,
    };
    if (source !== "webhook") {
      await this.insertEvent(tx, updated.bookingId, updated.paymentId, "refund_response", eventPayload);
    }
    if (updated.status === "approved") {
      await this.insertEvent(tx, updated.bookingId, updated.paymentId, "refund_confirmed", eventPayload);
    }

    const notifiers: Notify[] = [];
    let bookingStatus = booking.status;

    if (transition === "accept" || transition === "complete") {
      if (updated.reason === "customer_cancellation") {
        const cancelled = await this.cancelBookingForRefund(tx, updated, source);
        if (cancelled) {
          bookingStatus = "cancelled";
          notifiers.push(cancelled);
        }
      }
      if (updated.status === "approved") {
        await this.clearRefundReview(tx, updated.bookingId);
      }
      const emailReasons: string[] = ["customer_cancellation", "expired_booking_review"];
      if (transition === "accept" && source !== "webhook" && emailReasons.includes(updated.reason)) {
        notifiers.push(() => this.sendRefundRequestedEmail(updated.bookingId, updated.amountCents));
      }
    }

    if (transition === "reject" && booking.status === "cancelled") {
      // The refund had been accepted (seats already released): money is still with us, a human must act.
      await tx
        .update(schema.bookings)
        .set({ needsRefundReview: true })
        .where(eq(schema.bookings.id, updated.bookingId));
      this.logger.warn(
        `Refund rejected after the booking was cancelled, review refund: bookingId=${updated.bookingId} ` +
          `refundId=${updated.id} externalRefundId=${updated.externalRefundId ?? "unknown"}`,
      );
    }

    return { refund: updated, bookingStatus, notify: combine(notifiers) };
  }

  /**
   * Webhook effect of a payment carrying refunds (`refunded`, or `approved`
   * with a refund still in process / rejected). Each provider refund is matched
   * to its `refunds` row by `external_refund_id`, else to the payment's active
   * row still missing it (lost sync response), and goes through
   * {@link applyRefundStatus}. A refund with no row at all was made outside our
   * API (Mercado Pago panel) and is recorded as `external`.
   */
  async applyRefundedPayment(tx: RefundDbTransaction, context: RefundedPaymentContext): Promise<Notify> {
    if (!context.paymentId) {
      this.logger.warn(`Refund notification without a payment row: bookingId=${context.bookingId}`);
      return noop;
    }

    const notifiers: Notify[] = [];
    for (const providerRefund of context.refunds) {
      const externalRefundId = providerRefund.id != null ? String(providerRefund.id) : null;
      const row = await this.findRefundRowFor(tx, context.paymentId, externalRefundId);
      if (row) {
        const applied = await this.applyRefundStatus(tx, row, providerRefund, "webhook");
        notifiers.push(applied.notify);
        continue;
      }
      if (context.paymentStatus === "refunded" && normalizeProviderRefundStatus(providerRefund.status) === "approved") {
        const amountCents =
          providerRefund.amount != null ? Math.round(providerRefund.amount * CENTS_PER_UNIT) : context.amountCents;
        notifiers.push(
          await this.recordExternalRefund(tx, {
            bookingId: context.bookingId,
            paymentId: context.paymentId,
            externalRefundId,
            amountCents,
          }),
        );
        continue;
      }
      this.logger.warn(
        `Unmatched refund on payment: bookingId=${context.bookingId} paymentId=${context.paymentId} ` +
          `externalRefundId=${externalRefundId ?? "unknown"} status=${providerRefund.status ?? "unknown"}`,
      );
    }

    if (context.refunds.length === 0 && context.paymentStatus === "refunded") {
      const [approvedRow] = await tx
        .select({ id: schema.refunds.id })
        .from(schema.refunds)
        .where(and(eq(schema.refunds.paymentId, context.paymentId), eq(schema.refunds.status, "approved")));
      if (!approvedRow) {
        notifiers.push(
          await this.recordExternalRefund(tx, {
            bookingId: context.bookingId,
            paymentId: context.paymentId,
            externalRefundId: null,
            amountCents: context.amountCents,
          }),
        );
      }
    }

    return combine(notifiers);
  }

  private async findRefundRowFor(
    tx: RefundDbTransaction,
    paymentId: string,
    externalRefundId: string | null,
  ): Promise<schema.Refund | undefined> {
    if (externalRefundId) {
      const [byExternalId] = await tx
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.externalRefundId, externalRefundId));
      if (byExternalId) return byExternalId;
    }
    const [active] = await tx
      .select()
      .from(schema.refunds)
      .where(
        and(
          eq(schema.refunds.paymentId, paymentId),
          inArray(schema.refunds.status, ["requested", "in_process"]),
          isNull(schema.refunds.externalRefundId),
        ),
      )
      .limit(1);
    return active;
  }

  /** D7: money returned outside our API must not leave a valid ticket behind. */
  private async recordExternalRefund(
    tx: RefundDbTransaction,
    values: { bookingId: string; paymentId: string; externalRefundId: string | null; amountCents: number },
  ): Promise<Notify> {
    const [inserted] = await tx
      .insert(schema.refunds)
      .values({
        bookingId: values.bookingId,
        paymentId: values.paymentId,
        externalRefundId: values.externalRefundId,
        status: "approved",
        amountCents: values.amountCents,
        reason: "external",
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      this.logger.warn(
        `External refund conflicts with an existing refund, ignored: bookingId=${values.bookingId} ` +
          `paymentId=${values.paymentId} externalRefundId=${values.externalRefundId ?? "unknown"}`,
      );
      return noop;
    }

    this.logger.warn(
      `Refund made outside the API recorded as external: bookingId=${values.bookingId} ` +
        `refundId=${inserted.id} externalRefundId=${values.externalRefundId ?? "unknown"}`,
    );
    await this.insertEvent(tx, inserted.bookingId, inserted.paymentId, "refund_confirmed", {
      attempt_id: inserted.paymentId,
      refund_id: inserted.id,
      mp_refund_id: inserted.externalRefundId,
      refund_status: inserted.status,
      amount_cents: inserted.amountCents,
      reason: inserted.reason,
      source: "webhook",
    });

    await tx
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, inserted.bookingId))
      .for("update");
    const notify = (await this.cancelBookingForRefund(tx, inserted, "webhook")) ?? noop;
    await this.clearRefundReview(tx, inserted.bookingId);
    return notify;
  }

  /** Cancels the refund's booking if still confirmed; returns its post-commit broadcast, or null when nothing changed. */
  private async cancelBookingForRefund(
    tx: RefundDbTransaction,
    refund: schema.Refund,
    source: PaymentEventSource,
  ): Promise<Notify | null> {
    const cancellation = await this.bookingService.cancelConfirmedBooking(tx, refund.bookingId);
    if (!cancellation.cancelled) return null;
    await this.insertEvent(tx, refund.bookingId, refund.paymentId, "booking_cancelled", {
      attempt_id: refund.paymentId,
      refund_id: refund.id,
      status: "cancelled",
      reason: refund.reason,
      source,
    });
    return cancellation.notify;
  }

  private async clearRefundReview(tx: RefundDbTransaction, bookingId: string): Promise<void> {
    await tx
      .update(schema.bookings)
      .set({ needsRefundReview: false })
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.needsRefundReview, true)));
  }

  /**
   * Inside tx1: reuses the payment's stalled `requested` row (same idempotency
   * key), refuses while another request is in flight, otherwise inserts a new
   * `requested` row plus its `refund_requested` event.
   */
  private async requestRefundRow(
    tx: RefundDbTransaction,
    params: {
      bookingId: string;
      payment: { id: string; amountCents: number };
      reason: RefundReason;
      requestedBy: string;
      source: PaymentEventSource;
    },
  ): Promise<schema.Refund> {
    const [active] = await tx
      .select({ refund: schema.refunds, stale: staleRequestedRefund() })
      .from(schema.refunds)
      .where(
        and(
          eq(schema.refunds.paymentId, params.payment.id),
          inArray(schema.refunds.status, ["requested", "in_process", "approved"]),
        ),
      )
      .limit(1);
    if (active) {
      if (active.refund.status === "requested" && active.stale) {
        return active.refund;
      }
      throw new RefundInProgressException();
    }

    let inserted: schema.Refund;
    try {
      [inserted] = await tx
        .insert(schema.refunds)
        .values({
          bookingId: params.bookingId,
          paymentId: params.payment.id,
          status: "requested",
          amountCents: params.payment.amountCents,
          reason: params.reason,
          requestedBy: params.requestedBy,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new RefundInProgressException();
      throw err;
    }

    await this.insertEvent(tx, params.bookingId, params.payment.id, "refund_requested", {
      attempt_id: params.payment.id,
      refund_id: inserted.id,
      refund_status: inserted.status,
      amount_cents: inserted.amountCents,
      reason: inserted.reason,
      source: params.source,
    });
    return inserted;
  }

  /** Calls `PaymentRefund.total` outside any transaction, then applies the answer in tx2. */
  private async callProviderAndApply(
    refund: schema.Refund,
    externalPaymentId: string,
    source: PaymentEventSource,
  ): Promise<AppliedRefundStatus> {
    let providerRefund: ProviderRefund;
    try {
      providerRefund = await this.refundClient.total(buildRefundRequest(externalPaymentId, refund.id));
    } catch (err) {
      const failure = classifyRefundProviderError(err);
      if (failure.kind === "in_progress") throw new RefundInProgressException();
      if (failure.kind === "timeout") throw new RefundProviderTimeoutException();
      await this.recordRequestFailure(refund, failure.errorCode, source);
      throw new RefundRequestInvalidException();
    }

    const applied = await this.db.transaction((tx) => this.applyRefundStatus(tx, refund, providerRefund, source));
    await applied.notify();
    return this.assertAccepted(applied);
  }

  /** Admin "Atualizar status" on an `in_process` refund: re-fetches the payment and applies the refund found there. */
  private async reconcileRefund(refund: schema.Refund, externalPaymentId: string): Promise<AppliedRefundStatus> {
    let payment: Awaited<ReturnType<Payment["get"]>>;
    try {
      payment = await this.paymentClient.get({ id: Number(externalPaymentId) });
    } catch (err) {
      const failure = classifyRefundProviderError(err);
      if (failure.kind === "invalid") throw new RefundRequestInvalidException();
      throw new RefundProviderTimeoutException();
    }

    const providerRefunds: ProviderRefund[] = payment.refunds ?? [];
    const match =
      providerRefunds.find((candidate) => candidate.id != null && String(candidate.id) === refund.externalRefundId) ??
      (refund.externalRefundId ? undefined : providerRefunds[0]);

    const applied = await this.db.transaction(async (tx) => {
      if (!match) {
        const [current] = await tx.select().from(schema.refunds).where(eq(schema.refunds.id, refund.id));
        const [booking] = await tx
          .select({ status: schema.bookings.status })
          .from(schema.bookings)
          .where(eq(schema.bookings.id, refund.bookingId));
        return { refund: current, bookingStatus: booking.status, notify: noop };
      }
      return this.applyRefundStatus(tx, refund, match, "admin");
    });
    await applied.notify();
    return this.assertAccepted(applied);
  }

  /** Maps the refund's final state after tx2 to the D4 error responses. */
  private assertAccepted(applied: AppliedRefundStatus): AppliedRefundStatus {
    if (applied.refund.status === "rejected") throw new RefundRejectedException();
    if (applied.refund.status === "failed") throw new RefundRequestInvalidException();
    return applied;
  }

  private async recordRequestFailure(
    refund: schema.Refund,
    errorCode: string,
    source: PaymentEventSource,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [failed] = await tx
        .update(schema.refunds)
        .set({ status: "failed", errorCode, updatedAt: sql`now()` })
        .where(and(eq(schema.refunds.id, refund.id), eq(schema.refunds.status, "requested")))
        .returning();
      if (!failed) return;
      await this.insertEvent(tx, failed.bookingId, failed.paymentId, "refund_request_failed", {
        attempt_id: failed.paymentId,
        refund_id: failed.id,
        refund_status: failed.status,
        amount_cents: failed.amountCents,
        reason: failed.reason,
        error_code: errorCode,
        source,
      });
    });
  }

  private async findApprovedPayment(tx: RefundDbTransaction, bookingId: string) {
    const [payment] = await tx
      .select({
        id: schema.payments.id,
        externalPaymentId: schema.payments.externalPaymentId,
        amountCents: schema.payments.amountCents,
      })
      .from(schema.payments)
      .where(and(eq(schema.payments.bookingId, bookingId), eq(schema.payments.status, "approved")))
      .orderBy(desc(schema.payments.updatedAt))
      .limit(1);
    if (!payment?.externalPaymentId) return undefined;
    return { ...payment, externalPaymentId: payment.externalPaymentId };
  }

  /** AC8 replay: the already-cancelled booking with its last refund, without calling Mercado Pago. */
  private async currentCancellation(tx: RefundDbTransaction, bookingId: string): Promise<CancelBookingResult> {
    const [lastRefund] = await tx
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.bookingId, bookingId))
      .orderBy(desc(schema.refunds.createdAt))
      .limit(1);
    return {
      bookingId,
      status: "cancelled",
      refund: lastRefund
        ? {
            id: lastRefund.id,
            status: toCustomerRefundStatus(lastRefund.status),
            amountCents: lastRefund.amountCents,
          }
        : null,
    };
  }

  /**
   * Appends to `payment_events`. `clock_timestamp()` (not the transaction's
   * `now()`) keeps several events of the same transaction in insertion order.
   */
  private async insertEvent(
    tx: RefundDbTransaction,
    bookingId: string,
    paymentId: string | null,
    type: string,
    payload: Parameters<typeof buildPaymentEventPayload>[0],
  ): Promise<void> {
    await tx.insert(schema.paymentEvents).values({
      bookingId,
      paymentId,
      type,
      payload: buildPaymentEventPayload(payload),
      createdAt: sql`clock_timestamp()`,
    });
  }

  /** D5: best-effort, after commit; an SMTP failure is only logged. */
  private async sendRefundRequestedEmail(bookingId: string, amountCents: number): Promise<void> {
    try {
      const booking = await this.db.query.bookings.findFirst({
        where: eq(schema.bookings.id, bookingId),
        with: { user: true, session: { with: { movie: true, room: { with: { cinema: true } } } } },
      });
      if (!booking) return;
      await this.notificationService.sendRefundRequestedEmail({
        to: booking.user.email,
        bookingId: booking.id,
        movieTitle: booking.session.movie.title,
        cinemaName: booking.session.room.cinema.name,
        roomName: booking.session.room.name,
        startsAt: booking.session.startsAt,
        seatLabels: booking.cancelledSeatLabels ?? [],
        amountCents,
      });
    } catch (err) {
      this.logger.warn(`Failed to send refund requested email for ${bookingId}: ${err}`);
    }
  }
}
