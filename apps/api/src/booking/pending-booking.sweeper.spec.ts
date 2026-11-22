import { Logger } from "@nestjs/common";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { SeatingGateway } from "../seating/seating.gateway";
import { PendingBookingSweeper, SWEEP_BATCH_SIZE } from "./pending-booking.sweeper";
import { createMockBusinessMetrics } from "../../test/helpers/business-metrics-mock";
import { BusinessMetrics } from "../telemetry/business-metrics";

const mockMetrics = createMockBusinessMetrics();

describe("PendingBookingSweeper", () => {
  const tx = { select: jest.fn(), update: jest.fn(), delete: jest.fn() };
  const mockDb = { transaction: jest.fn(), update: jest.fn() };
  const mockGateway = { broadcastSeatUpdate: jest.fn() };

  let sweeper: PendingBookingSweeper;
  let expiredBatches: { id: string; sessionId: string }[][];
  let deletedSeats: { bookingId: string; seatId: string }[];
  let staleRows: { id: string; paymentStatus: string }[];

  function chain(result: unknown) {
    return { set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(result) }) }) };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    expiredBatches = [[]];
    deletedSeats = [];
    staleRows = [];

    const candidates = { for: jest.fn().mockReturnValue({}) };
    tx.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue(candidates) }) }),
      }),
    });
    tx.update.mockImplementation(() => chain(expiredBatches.shift() ?? []));
    tx.delete.mockImplementation(() => ({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(deletedSeats) }) }));
    mockDb.transaction.mockImplementation(async (callback: (t: typeof tx) => unknown) => callback(tx));
    mockDb.update.mockImplementation(() => chain(staleRows));

    const moduleRef = await Test.createTestingModule({
      providers: [
        PendingBookingSweeper,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SeatingGateway, useValue: mockGateway },
        { provide: BusinessMetrics, useValue: mockMetrics },
      ],
    }).compile();
    sweeper = moduleRef.get(PendingBookingSweeper);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should skip the tick while a previous run is still in progress", async () => {
    // ARRANGE — the first run hangs inside its transaction
    let finishFirstRun!: () => void;
    mockDb.transaction.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirstRun = () => resolve({ bookings: [], seats: [] }))),
    );
    const debug = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    const firstRun = sweeper.run();

    // ACT
    const secondRun = await sweeper.run();

    // ASSERT
    expect(secondRun).toBeUndefined();
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("skipping"));
    finishFirstRun();
    await expect(firstRun).resolves.toEqual({ expiredBookingIds: [], stalePaymentAlertBookingIds: [] });
  });

  it("should run again on the next tick once the previous run finished", async () => {
    // ARRANGE
    await sweeper.run();

    // ACT
    const result = await sweeper.run();

    // ASSERT
    expect(result).toEqual({ expiredBookingIds: [], stalePaymentAlertBookingIds: [] });
    expect(mockDb.transaction).toHaveBeenCalledTimes(2);
  });

  it("should delegate the scheduled interval to a sweep run", async () => {
    // ARRANGE
    const run = jest.spyOn(sweeper, "run");

    // ACT
    await sweeper.handleInterval();

    // ASSERT
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should broadcast every freed seat as released in its booking's session room", async () => {
    // ARRANGE
    expiredBatches = [
      [
        { id: "b1", sessionId: "session-1" },
        { id: "b2", sessionId: "session-2" },
      ],
    ];
    deletedSeats = [
      { bookingId: "b1", seatId: "s1" },
      { bookingId: "b1", seatId: "s2" },
      { bookingId: "b2", seatId: "s3" },
    ];

    // ACT
    const result = await sweeper.run();

    // ASSERT
    expect(result?.expiredBookingIds).toEqual(["b1", "b2"]);
    expect(mockGateway.broadcastSeatUpdate.mock.calls).toEqual([
      ["session-1", { seatId: "s1", status: "released" }],
      ["session-1", { seatId: "s2", status: "released" }],
      ["session-2", { seatId: "s3", status: "released" }],
    ]);
  });

  it("should neither delete seats nor broadcast when nothing is expirable", async () => {
    // ARRANGE
    expiredBatches = [[]];

    // ACT
    await sweeper.run();

    // ASSERT
    expect(tx.delete).not.toHaveBeenCalled();
    expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { firstBatch: SWEEP_BATCH_SIZE, expectedTransactions: 2 },
    { firstBatch: SWEEP_BATCH_SIZE - 1, expectedTransactions: 1 },
  ])("should run $expectedTransactions batch(es) when the first batch expires $firstBatch bookings", async ({ firstBatch, expectedTransactions }) => {
    // ARRANGE
    const fullBatch = Array.from({ length: firstBatch }, (_, i) => ({ id: `b${i}`, sessionId: "session-1" }));
    expiredBatches = [fullBatch, []];

    // ACT
    await sweeper.run();

    // ASSERT
    expect(mockDb.transaction).toHaveBeenCalledTimes(expectedTransactions);
  });

  it("should log a single warning per booking whose payment is in flight for more than 24h", async () => {
    // ARRANGE
    staleRows = [{ id: "b7", paymentStatus: "in_process" }];
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    // ACT
    const result = await sweeper.run();

    // ASSERT
    expect(result?.stalePaymentAlertBookingIds).toEqual(["b7"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining("bookingId=b7"));
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining("paymentStatus=in_process"));
  });

  it("should log the error without throwing and clear the running flag when a sweep fails", async () => {
    // ARRANGE
    mockDb.transaction.mockRejectedValueOnce(new Error("connection lost"));
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    // ACT
    const failed = await sweeper.run();
    const next = await sweeper.run();

    // ASSERT
    expect(failed).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("connection lost"));
    expect(next).toEqual({ expiredBookingIds: [], stalePaymentAlertBookingIds: [] });
  });
  describe("telemetry", () => {
    let exporter: InMemorySpanExporter;
    let provider: TracerProvider;

    beforeEach(() => {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      exporter = new InMemorySpanExporter();
      provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
      trace.setGlobalTracerProvider(provider);
    });

    afterEach(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
    });

    function sweeperSpans() {
      return exporter.getFinishedSpans().filter((span) => span.name === "pending-booking-sweeper.run");
    }

    it("should record a successful run with the expired bookings and stale payment alerts", async () => {
      // ARRANGE
      expiredBatches = [
        [
          { id: "b1", sessionId: "session-1" },
          { id: "b2", sessionId: "session-1" },
        ],
      ];
      staleRows = [{ id: "b7", paymentStatus: "in_process" }];
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      // ACT
      await sweeper.run();

      // ASSERT
      expect(mockMetrics.sweeperRun).toHaveBeenCalledWith("success", expect.any(Number));
      expect(mockMetrics.bookingExpired).toHaveBeenCalledWith("sweeper", 2);
      expect(mockMetrics.paymentStaleAlert).toHaveBeenCalledWith(1);
      const [span] = sweeperSpans();
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.attributes).toEqual({ "sweeper.outcome": "success", "sweeper.expired_count": 2 });
    });

    it("should record a skipped run when the previous tick is still running", async () => {
      // ARRANGE
      let finishFirstRun!: () => void;
      mockDb.transaction.mockImplementationOnce(
        () => new Promise((resolve) => (finishFirstRun = () => resolve({ bookings: [], seats: [] }))),
      );
      jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
      const firstRun = sweeper.run();

      // ACT
      await sweeper.run();

      // ASSERT
      expect(mockMetrics.sweeperRun).toHaveBeenCalledWith("skipped", expect.any(Number));
      finishFirstRun();
      await firstRun;
      expect(mockMetrics.sweeperRun).toHaveBeenLastCalledWith("success", expect.any(Number));
      expect(sweeperSpans().map((span) => span.attributes["sweeper.outcome"])).toEqual(["skipped", "success"]);
    });

    it("should record an error run without counting expirations that rolled back", async () => {
      // ARRANGE
      mockDb.transaction.mockRejectedValueOnce(new Error("connection lost"));
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      // ACT
      await sweeper.run();

      // ASSERT
      expect(mockMetrics.sweeperRun).toHaveBeenCalledWith("error", expect.any(Number));
      expect(mockMetrics.bookingExpired).not.toHaveBeenCalled();
      expect(mockMetrics.paymentStaleAlert).not.toHaveBeenCalled();
      expect(sweeperSpans()[0].attributes).toEqual({ "sweeper.outcome": "error", "sweeper.expired_count": 0 });
    });

    it("should keep counting a committed batch when a later batch fails", async () => {
      // ARRANGE
      const fullBatch = Array.from({ length: SWEEP_BATCH_SIZE }, (_, i) => ({ id: `b${i}`, sessionId: "session-1" }));
      expiredBatches = [fullBatch];
      mockDb.transaction
        .mockImplementationOnce(async (callback: (t: typeof tx) => unknown) => callback(tx))
        .mockRejectedValueOnce(new Error("connection lost"));
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      // ACT
      await sweeper.run();

      // ASSERT
      expect(mockMetrics.bookingExpired).toHaveBeenCalledWith("sweeper", SWEEP_BATCH_SIZE);
      expect(mockMetrics.sweeperRun).toHaveBeenCalledWith("error", expect.any(Number));
      expect(sweeperSpans()[0].attributes["sweeper.expired_count"]).toBe(SWEEP_BATCH_SIZE);
    });
  });
});
