import { ConfigService } from "@nestjs/config";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createMockBusinessMetrics } from "../../test/helpers/business-metrics-mock";
import { BusinessMetrics } from "../telemetry/business-metrics";
import { HoldExpiryListener, parseHoldKey } from "./hold-expiry.listener";
import { SeatingGateway } from "./seating.gateway";

describe("parseHoldKey", () => {
  it("should parse a well-formed hold key into its session and seat ids", () => {
    // ARRANGE
    const key = "seat-hold:session-1:seat-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toEqual({ sessionId: "session-1", seatId: "seat-1" });
  });

  it("should return undefined for a key that isn't a seat hold", () => {
    // ARRANGE
    const key = "some-other-key:session-1:seat-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toBeUndefined();
  });

  it("should return undefined when the key is missing a segment", () => {
    // ARRANGE
    const key = "seat-hold:session-1";

    // ACT
    const result = parseHoldKey(key);

    // ASSERT
    expect(result).toBeUndefined();
  });
});

describe("HoldExpiryListener.handleExpiredKey", () => {
  const mockGateway = { broadcastSeatUpdate: jest.fn() };
  const mockMetrics = createMockBusinessMetrics();
  let listener: HoldExpiryListener;
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    trace.setGlobalTracerProvider(provider);
    listener = new HoldExpiryListener(
      {} as ConfigService,
      mockGateway as unknown as SeatingGateway,
      mockMetrics as unknown as BusinessMetrics,
    );
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("should count an expired release and broadcast it inside a seat-hold.expired root span", async () => {
    // ARRANGE
    const key = "seat-hold:session-1:seat-1";

    // ACT
    await listener.handleExpiredKey(key);

    // ASSERT
    expect(mockMetrics.seatHoldReleased).toHaveBeenCalledWith("expired");
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "released" });
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("seat-hold.expired");
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toEqual({ "session.id": "session-1", "seat.id": "seat-1" });
  });

  it("should ignore keys that are not seat holds, without span or metric", async () => {
    // ARRANGE
    const key = "guest-holds:guest-1";

    // ACT
    await listener.handleExpiredKey(key);

    // ASSERT
    expect(mockMetrics.seatHoldReleased).not.toHaveBeenCalled();
    expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
