import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPoint,
  Histogram,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { allowlisted, BusinessMetrics, OTHER } from "./business-metrics";

interface RecordedPoint {
  name: string;
  unit: string;
  attributes: Record<string, unknown>;
  value: number | DataPoint<Histogram>["value"];
}

describe("BusinessMetrics", () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;
  let businessMetrics: BusinessMetrics;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    meterProvider = new MeterProvider({ readers: [reader] });
    businessMetrics = new BusinessMetrics(meterProvider);
  });

  afterEach(async () => {
    await meterProvider.shutdown();
  });

  async function recorded(): Promise<RecordedPoint[]> {
    await reader.forceFlush();
    return (exporter.getMetrics().at(-1)?.scopeMetrics ?? []).flatMap((scope) =>
      scope.metrics.flatMap((metric) =>
        metric.dataPoints.map((point) => ({
          name: metric.descriptor.name,
          unit: metric.descriptor.unit,
          attributes: point.attributes,
          value: point.value as RecordedPoint["value"],
        })),
      ),
    );
  }

  it.each([
    ["seatHoldCreated", ["guest"], "movietickets.seat_hold.created", "{hold}", { "holder.kind": "guest" }, 1],
    ["seatHoldRejected", ["limit_reached"], "movietickets.seat_hold.rejected", "{hold}", { reason: "limit_reached" }, 1],
    ["seatHoldReleased", ["release_all", 3], "movietickets.seat_hold.released", "{hold}", { reason: "release_all" }, 3],
    ["seatHoldTransferred", [2], "movietickets.seat_hold.transferred", "{hold}", {}, 2],
    ["bookingConfirmed", ["payment_webhook"], "movietickets.booking.confirmed", "{booking}", { "confirmation.source": "payment_webhook" }, 1],
    ["bookingExpired", ["sweeper", 4], "movietickets.booking.expired", "{booking}", { "expiry.trigger": "sweeper" }, 4],
    ["bookingCancelled", [], "movietickets.booking.cancelled", "{booking}", {}, 1],
    ["bookingRefundReviewFlagged", [], "movietickets.booking.refund_review_flagged", "{booking}", {}, 1],
    ["paymentAttemptCreated", [], "movietickets.payment.attempt.created", "{payment}", {}, 1],
    [
      "paymentStatusChanged",
      ["approved", "webhook"],
      "movietickets.payment.status_changed",
      "{payment}",
      { "payment.status": "approved", "payment.source": "webhook" },
      1,
    ],
    ["paymentProviderError", ["timeout"], "movietickets.payment.provider.errors", "{error}", { "error.type": "timeout" }, 1],
    ["paymentStaleAlert", [2], "movietickets.payment.stale_alert", "{payment}", {}, 2],
    ["wsConnectionRejected", ["invalid_token"], "movietickets.seating.ws.rejected", "{connection}", { reason: "invalid_token" }, 1],
    ["seatBroadcast", ["booked"], "movietickets.seating.broadcasts", "{event}", { "seat.status": "booked" }, 1],
    ["confirmationEmail", ["failed"], "movietickets.notification.email", "{email}", { outcome: "failed" }, 1],
    ["refundRequested", [], "movietickets.refund.requested", "{refund}", {}, 1],
    ["refundStatusChanged", ["in_process"], "movietickets.refund.status_changed", "{refund}", { "refund.status": "in_process" }, 1],
  ] as const)(
    "should record %s on the right counter with only the allowlisted attributes",
    async (method, args, name, unit, attributes, value) => {
      // ARRANGE
      const call = businessMetrics[method] as (...params: unknown[]) => void;

      // ACT
      call.apply(businessMetrics, [...args]);

      // ASSERT
      const points = await recorded();
      expect(points).toEqual([{ name, unit, attributes, value }]);
    },
  );

  it.each([
    ["seatHoldCreated", ["robot"], { "holder.kind": OTHER }],
    ["seatHoldRejected", ["Seat booked by user 42"], { reason: OTHER }],
    ["seatHoldReleased", ["gc"], { reason: OTHER }],
    ["bookingConfirmed", ["pix"], { "confirmation.source": OTHER }],
    ["bookingExpired", ["cron"], { "expiry.trigger": OTHER }],
    ["paymentStatusChanged", ["approved_with_fraud_check", "polling"], { "payment.status": OTHER, "payment.source": OTHER }],
    ["paymentProviderError", ["ECONNRESET"], { "error.type": OTHER }],
    ["wsConnectionRejected", ["banned"], { reason: OTHER }],
    ["seatBroadcast", ["sold"], { "seat.status": OTHER }],
    ["confirmationEmail", ["bounced"], { outcome: OTHER }],
    ["refundStatusChanged", ["requested"], { "refund.status": OTHER }],
    ["sweeperRun", ["crashed", 0.1], { outcome: OTHER }],
  ] as const)("should record an unknown %s attribute value as other", async (method, args, attributes) => {
    // ARRANGE
    const call = businessMetrics[method] as (...params: unknown[]) => void;

    // ACT
    call.apply(businessMetrics, [...args]);

    // ASSERT
    const points = await recorded();
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.attributes).toEqual(attributes);
    }
  });

  it("should count a booking and record its seat count in the seats histogram", async () => {
    // ARRANGE
    const seatCount = 3;

    // ACT
    businessMetrics.bookingCreated(seatCount);

    // ASSERT
    const points = await recorded();
    expect(points.find((point) => point.name === "movietickets.booking.created")).toMatchObject({
      unit: "{booking}",
      attributes: {},
      value: 1,
    });
    const seats = points.find((point) => point.name === "movietickets.booking.seats");
    expect(seats).toMatchObject({ unit: "{seat}", attributes: {}, value: { count: 1, sum: 3 } });
    expect((seats?.value as DataPoint<Histogram>["value"]).buckets.boundaries).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("should count a sweeper run and record its duration under the same outcome", async () => {
    // ARRANGE
    const durationSeconds = 0.25;

    // ACT
    businessMetrics.sweeperRun("success", durationSeconds);

    // ASSERT
    const points = await recorded();
    expect(points.find((point) => point.name === "movietickets.sweeper.runs")).toMatchObject({
      unit: "{run}",
      attributes: { outcome: "success" },
      value: 1,
    });
    expect(points.find((point) => point.name === "movietickets.sweeper.duration")).toMatchObject({
      unit: "s",
      attributes: { outcome: "success" },
      value: { count: 1, sum: 0.25 },
    });
  });

  it("should move the WebSocket connections gauge up and down", async () => {
    // ARRANGE
    businessMetrics.wsConnectionOpened();
    businessMetrics.wsConnectionOpened();

    // ACT
    businessMetrics.wsConnectionClosed();

    // ASSERT
    const points = await recorded();
    expect(points).toEqual([
      { name: "movietickets.seating.ws.connections", unit: "{connection}", attributes: {}, value: 1 },
    ]);
  });

  it.each([
    ["seatHoldReleased", ["booked", 0]],
    ["seatHoldTransferred", [0]],
    ["bookingExpired", ["lazy", 0]],
    ["paymentStatusChanged", ["abandoned", "sync", 0]],
    ["paymentStaleAlert", [0]],
  ] as const)("should not record anything when %s gets a zero count", async (method, args) => {
    // ARRANGE
    const call = businessMetrics[method] as (...params: unknown[]) => void;

    // ACT
    call.apply(businessMetrics, [...args]);

    // ASSERT
    expect(await recorded()).toEqual([]);
  });

  it("should be a silent no-op on the global no-op MeterProvider (telemetry off)", () => {
    // ARRANGE
    const noopMetrics = new BusinessMetrics(metrics.getMeterProvider());

    // ACT
    const emitAll = () => {
      noopMetrics.seatHoldCreated("user");
      noopMetrics.bookingCreated(2);
      noopMetrics.sweeperRun("success", 0.1);
      noopMetrics.wsConnectionOpened();
    };

    // ASSERT
    expect(emitAll).not.toThrow();
  });
});

describe("allowlisted", () => {
  it.each([
    ["approved", "approved"],
    ["brand_new_status", OTHER],
    [null, OTHER],
    [undefined, OTHER],
  ])("should map %p to %p", (value, expected) => {
    // ARRANGE
    const allowed = ["approved", "rejected"];

    // ACT
    const result = allowlisted(value, allowed);

    // ASSERT
    expect(result).toBe(expected);
  });
});
