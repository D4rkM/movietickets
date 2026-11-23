import { Inject, Injectable } from "@nestjs/common";
import { Attributes, Counter, Histogram, MeterProvider, UpDownCounter } from "@opentelemetry/api";

/**
 * Injection token for the MeterProvider BusinessMetrics creates its instruments
 * from. TelemetryModule binds it to the global provider; integration tests
 * override it with an in-memory one.
 */
export const METER_PROVIDER = Symbol("METER_PROVIDER");

export const METER_NAME = "movietickets-api";

/** Value recorded for any attribute value outside its allowlist (keeps cardinality bounded). */
export const OTHER = "other";

export const HOLDER_KINDS = ["user", "guest"] as const;
export const HOLD_REJECTION_REASONS = ["booked", "held_by_other", "limit_reached"] as const;
export const HOLD_RELEASE_REASONS = ["manual", "release_all", "booked", "expired", "transfer_overflow"] as const;
export const CONFIRMATION_SOURCES = ["payment_sync", "payment_webhook", "mock"] as const;
export const EXPIRY_TRIGGERS = ["sweeper", "lazy"] as const;
export const PAYMENT_STATUSES = [
  "approved",
  "rejected",
  "cancelled",
  "pending",
  "in_process",
  "authorized",
  "refunded",
  "charged_back",
  "in_mediation",
  "request_failed",
  "abandoned",
] as const;
export const PAYMENT_SOURCES = ["sync", "webhook"] as const;
export const PAYMENT_PROVIDER_ERROR_TYPES = ["timeout", "request_invalid"] as const;
export const SWEEPER_OUTCOMES = ["success", "error", "skipped"] as const;
export const WS_REJECTION_REASONS = ["missing_token", "invalid_token"] as const;
export const SEAT_EVENT_STATUSES = ["held", "released", "booked"] as const;
export const EMAIL_OUTCOMES = ["sent", "failed"] as const;
export const REFUND_STATUSES = ["in_process", "approved", "rejected", "failed"] as const;

/** Explicit buckets for seats per booking (1–6 seats; 6 is the per-session hold limit). */
export const BOOKING_SEATS_BUCKETS = [1, 2, 3, 4, 5, 6];
/** Sweeper tick duration buckets, in seconds. */
export const SWEEPER_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Returns `value` when it's in the allowlist, `other` otherwise (AC9). */
export function allowlisted(value: string | null | undefined, allowed: readonly string[]): string {
  return value != null && allowed.includes(value) ? value : OTHER;
}

/**
 * Business metrics (`movietickets.*`, see docs/flows/observability/spec.md,
 * "Métricas"). Services call these methods with business names and never touch
 * `@opentelemetry/api` directly. Every attribute is validated against a closed
 * allowlist and no id, email or free text is ever recorded, so cardinality stays
 * low. Callers emit only after the operation committed.
 *
 * Instruments are created in the constructor, not at module scope: the metrics
 * API has no proxy, so a meter obtained before the SDK registered its global
 * MeterProvider would stay a no-op forever. With telemetry off the global
 * provider is the no-op one and every call is free.
 */
@Injectable()
export class BusinessMetrics {
  private readonly seatHoldCreatedCounter: Counter;
  private readonly seatHoldRejectedCounter: Counter;
  private readonly seatHoldReleasedCounter: Counter;
  private readonly seatHoldTransferredCounter: Counter;
  private readonly bookingCreatedCounter: Counter;
  private readonly bookingSeatsHistogram: Histogram;
  private readonly bookingConfirmedCounter: Counter;
  private readonly bookingExpiredCounter: Counter;
  private readonly bookingCancelledCounter: Counter;
  private readonly bookingRefundReviewFlaggedCounter: Counter;
  private readonly paymentAttemptCreatedCounter: Counter;
  private readonly paymentStatusChangedCounter: Counter;
  private readonly paymentProviderErrorsCounter: Counter;
  private readonly paymentStaleAlertCounter: Counter;
  private readonly sweeperRunsCounter: Counter;
  private readonly sweeperDurationHistogram: Histogram;
  private readonly wsConnectionsUpDownCounter: UpDownCounter;
  private readonly wsRejectedCounter: Counter;
  private readonly broadcastsCounter: Counter;
  private readonly notificationEmailCounter: Counter;
  private readonly refundRequestedCounter: Counter;
  private readonly refundStatusChangedCounter: Counter;

  constructor(@Inject(METER_PROVIDER) meterProvider: MeterProvider) {
    const meter = meterProvider.getMeter(METER_NAME);

    this.seatHoldCreatedCounter = meter.createCounter("movietickets.seat_hold.created", {
      description: "Seat holds acquired (SET NX succeeded).",
      unit: "{hold}",
    });
    this.seatHoldRejectedCounter = meter.createCounter("movietickets.seat_hold.rejected", {
      description: "Seat hold attempts refused with a conflict.",
      unit: "{hold}",
    });
    this.seatHoldReleasedCounter = meter.createCounter("movietickets.seat_hold.released", {
      description: "Seat holds released, by reason.",
      unit: "{hold}",
    });
    this.seatHoldTransferredCounter = meter.createCounter("movietickets.seat_hold.transferred", {
      description: "Guest seat holds moved to the user on login.",
      unit: "{hold}",
    });
    this.bookingCreatedCounter = meter.createCounter("movietickets.booking.created", {
      description: "Pending bookings created.",
      unit: "{booking}",
    });
    this.bookingSeatsHistogram = meter.createHistogram("movietickets.booking.seats", {
      description: "Seats per created booking.",
      unit: "{seat}",
      advice: { explicitBucketBoundaries: BOOKING_SEATS_BUCKETS },
    });
    this.bookingConfirmedCounter = meter.createCounter("movietickets.booking.confirmed", {
      description: "Bookings confirmed, by confirmation source.",
      unit: "{booking}",
    });
    this.bookingExpiredCounter = meter.createCounter("movietickets.booking.expired", {
      description: "Pending bookings expired, by trigger.",
      unit: "{booking}",
    });
    this.bookingCancelledCounter = meter.createCounter("movietickets.booking.cancelled", {
      description: "Confirmed bookings cancelled.",
      unit: "{booking}",
    });
    this.bookingRefundReviewFlaggedCounter = meter.createCounter("movietickets.booking.refund_review_flagged", {
      description: "Expired bookings flagged for manual refund review after an approved payment.",
      unit: "{booking}",
    });
    this.paymentAttemptCreatedCounter = meter.createCounter("movietickets.payment.attempt.created", {
      description: "Payment attempts created.",
      unit: "{payment}",
    });
    this.paymentStatusChangedCounter = meter.createCounter("movietickets.payment.status_changed", {
      description: "Payment attempt status changes, by new status and source.",
      unit: "{payment}",
    });
    this.paymentProviderErrorsCounter = meter.createCounter("movietickets.payment.provider.errors", {
      description: "Mercado Pago payment creation failures, by error type.",
      unit: "{error}",
    });
    this.paymentStaleAlertCounter = meter.createCounter("movietickets.payment.stale_alert", {
      description: "Bookings alerted for a payment in flight for more than 24h.",
      unit: "{payment}",
    });
    this.sweeperRunsCounter = meter.createCounter("movietickets.sweeper.runs", {
      description: "Pending booking sweeper ticks, by outcome.",
      unit: "{run}",
    });
    this.sweeperDurationHistogram = meter.createHistogram("movietickets.sweeper.duration", {
      description: "Pending booking sweeper tick duration, by outcome.",
      unit: "s",
      advice: { explicitBucketBoundaries: SWEEPER_DURATION_BUCKETS },
    });
    this.wsConnectionsUpDownCounter = meter.createUpDownCounter("movietickets.seating.ws.connections", {
      description: "Authenticated WebSocket connections open on /seating.",
      unit: "{connection}",
    });
    this.wsRejectedCounter = meter.createCounter("movietickets.seating.ws.rejected", {
      description: "WebSocket connections refused at the JWT handshake, by reason.",
      unit: "{connection}",
    });
    this.broadcastsCounter = meter.createCounter("movietickets.seating.broadcasts", {
      description: "seat:update broadcasts, by seat status.",
      unit: "{event}",
    });
    this.notificationEmailCounter = meter.createCounter("movietickets.notification.email", {
      description: "Booking confirmation emails, by outcome.",
      unit: "{email}",
    });
    this.refundRequestedCounter = meter.createCounter("movietickets.refund.requested", {
      description: "Refunds requested (new refunds rows).",
      unit: "{refund}",
    });
    this.refundStatusChangedCounter = meter.createCounter("movietickets.refund.status_changed", {
      description: "Refund status changes, by new status.",
      unit: "{refund}",
    });
  }

  seatHoldCreated(holderKind: string): void {
    this.seatHoldCreatedCounter.add(1, { "holder.kind": allowlisted(holderKind, HOLDER_KINDS) });
  }

  seatHoldRejected(reason: string): void {
    this.seatHoldRejectedCounter.add(1, { reason: allowlisted(reason, HOLD_REJECTION_REASONS) });
  }

  seatHoldReleased(reason: string, count = 1): void {
    this.addPositive(this.seatHoldReleasedCounter, count, { reason: allowlisted(reason, HOLD_RELEASE_REASONS) });
  }

  seatHoldTransferred(count = 1): void {
    this.addPositive(this.seatHoldTransferredCounter, count);
  }

  bookingCreated(seatCount: number): void {
    this.bookingCreatedCounter.add(1);
    this.bookingSeatsHistogram.record(seatCount);
  }

  bookingConfirmed(source: string): void {
    this.bookingConfirmedCounter.add(1, { "confirmation.source": allowlisted(source, CONFIRMATION_SOURCES) });
  }

  bookingExpired(trigger: string, count = 1): void {
    this.addPositive(this.bookingExpiredCounter, count, { "expiry.trigger": allowlisted(trigger, EXPIRY_TRIGGERS) });
  }

  bookingCancelled(): void {
    this.bookingCancelledCounter.add(1);
  }

  bookingRefundReviewFlagged(): void {
    this.bookingRefundReviewFlaggedCounter.add(1);
  }

  paymentAttemptCreated(): void {
    this.paymentAttemptCreatedCounter.add(1);
  }

  paymentStatusChanged(status: string, source: string, count = 1): void {
    this.addPositive(this.paymentStatusChangedCounter, count, {
      "payment.status": allowlisted(status, PAYMENT_STATUSES),
      "payment.source": allowlisted(source, PAYMENT_SOURCES),
    });
  }

  paymentProviderError(errorType: string): void {
    this.paymentProviderErrorsCounter.add(1, { "error.type": allowlisted(errorType, PAYMENT_PROVIDER_ERROR_TYPES) });
  }

  paymentStaleAlert(count = 1): void {
    this.addPositive(this.paymentStaleAlertCounter, count);
  }

  sweeperRun(outcome: string, durationSeconds: number): void {
    const attributes = { outcome: allowlisted(outcome, SWEEPER_OUTCOMES) };
    this.sweeperRunsCounter.add(1, attributes);
    this.sweeperDurationHistogram.record(durationSeconds, attributes);
  }

  wsConnectionOpened(): void {
    this.wsConnectionsUpDownCounter.add(1);
  }

  wsConnectionClosed(): void {
    this.wsConnectionsUpDownCounter.add(-1);
  }

  wsConnectionRejected(reason: string): void {
    this.wsRejectedCounter.add(1, { reason: allowlisted(reason, WS_REJECTION_REASONS) });
  }

  seatBroadcast(seatStatus: string): void {
    this.broadcastsCounter.add(1, { "seat.status": allowlisted(seatStatus, SEAT_EVENT_STATUSES) });
  }

  confirmationEmail(outcome: string): void {
    this.notificationEmailCounter.add(1, { outcome: allowlisted(outcome, EMAIL_OUTCOMES) });
  }

  refundRequested(): void {
    this.refundRequestedCounter.add(1);
  }

  refundStatusChanged(status: string): void {
    this.refundStatusChangedCounter.add(1, { "refund.status": allowlisted(status, REFUND_STATUSES) });
  }

  /** Counters reject negative increments; a zero batch is simply not recorded. */
  private addPositive(counter: Counter, count: number, attributes?: Attributes): void {
    if (count > 0) counter.add(count, attributes);
  }
}
