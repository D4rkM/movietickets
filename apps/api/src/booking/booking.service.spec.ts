import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SQL } from "drizzle-orm";
import { DRIZZLE } from "../db/drizzle.module";
import { NotificationService } from "../notification/notification.service";
import { SeatingGateway } from "../seating/seating.gateway";
import { SeatingService } from "../seating/seating.service";
import { BookingExpiredException } from "./booking-expired.exception";
import { BookingService } from "./booking.service";
import { TicketType } from "./dto/book-seat.dto";

describe("BookingService", () => {
  const mockDb = {
    query: {
      sessions: { findFirst: jest.fn() },
      bookings: { findFirst: jest.fn(), findMany: jest.fn() },
      bookingSeats: { findMany: jest.fn() },
    },
    insert: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  };
  const mockGateway = { broadcastSeatUpdate: jest.fn() };
  const mockSeatingService = { releaseHoldsForBookedSeats: jest.fn() };
  const mockNotificationService = { sendBookingConfirmationEmail: jest.fn() };

  let service: BookingService;

  /** update().set().where().returning() resolving to the given rows, one call each. */
  function stubUpdates(...rowsPerCall: unknown[][]) {
    for (const rows of rowsPerCall) {
      mockDb.update.mockReturnValueOnce({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }),
        }),
      });
    }
  }

  /** delete().where().returning() resolving to the given rows. */
  function stubDelete(rows: unknown[]) {
    const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) });
    mockDb.delete.mockReturnValue({ where: deleteWhere });
    return deleteWhere;
  }

  /** Booking insert + one seat insert per seat; returns the booking values mock. */
  function stubBookingInserts(seatCount: number) {
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    mockDb.insert.mockReturnValueOnce({ values: bookingValues });
    for (let i = 0; i < seatCount; i++) {
      mockDb.insert.mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) });
    }
    return bookingValues;
  }

  // Wires mockDb.transaction to run the callback against a tx that shares
  // mockDb.insert, so existing insert-mock setups keep working unchanged.
  function stubTransaction() {
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) =>
      callback(mockDb),
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.update.mockReset();
    mockDb.insert.mockReset();
    stubTransaction();
    mockDb.query.bookingSeats.findMany.mockResolvedValue([]);
    // Subquery builder for the lazy-expiry lookup of conflicting bookings.
    mockDb.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({}) }) });
    // Default: the lazy-expiry UPDATE finds nothing to expire.
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    });
    mockNotificationService.sendBookingConfirmationEmail.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SeatingGateway, useValue: mockGateway },
        { provide: SeatingService, useValue: mockSeatingService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = moduleRef.get(BookingService);
  });

  it("should throw NotFoundException when the session does not exist", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.createBooking("missing-session", "seat-1", "user-1", TicketType.FULL, undefined);

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should charge full price and store no document for a full ticket", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2500 });
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    const bookingSeatValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: bookingValues })
      .mockReturnValueOnce({ values: bookingSeatValues });

    // ACT
    const result = await service.createBooking(
      "session-1",
      "seat-1",
      "user-1",
      TicketType.FULL,
      undefined,
    );

    // ASSERT
    expect(bookingValues).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-1",
      status: "pending",
      expiresAt: expect.any(SQL),
    });
    expect(bookingSeatValues).toHaveBeenCalledWith({
      bookingId: "booking-1",
      sessionId: "session-1",
      seatId: "seat-1",
      ticketType: TicketType.FULL,
      halfPriceDocument: null,
      priceCents: 2500,
    });
    expect(result).toEqual({
      bookingId: "booking-1",
      seatId: "seat-1",
      status: "pending",
      ticketType: TicketType.FULL,
      priceCents: 2500,
    });
  });

  it("should charge half price and store the document for a half ticket", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2501 });
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    const bookingSeatValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: bookingValues })
      .mockReturnValueOnce({ values: bookingSeatValues });

    // ACT
    const result = await service.createBooking(
      "session-1",
      "seat-1",
      "user-1",
      TicketType.HALF,
      "1234567890",
    );

    // ASSERT — 2501 cents rounds to 1251 (nearest cent), document is stored
    expect(bookingSeatValues).toHaveBeenCalledWith({
      bookingId: "booking-1",
      sessionId: "session-1",
      seatId: "seat-1",
      ticketType: TicketType.HALF,
      halfPriceDocument: "1234567890",
      priceCents: 1251,
    });
    expect(result.priceCents).toBe(1251);
  });

  it("should insert one booking row and one seat row per seat, all inside the same transaction", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    const bookingSeatValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: bookingValues })
      .mockReturnValueOnce({ values: bookingSeatValues })
      .mockReturnValueOnce({ values: bookingSeatValues });

    // ACT
    const result = await service.createBookingForSeats(
      "session-1",
      [
        { seatId: "seat-1", ticketType: TicketType.FULL },
        { seatId: "seat-2", ticketType: TicketType.HALF, halfPriceDocument: "1234567890" },
      ],
      "user-1",
    );

    // ASSERT — a single booking row backs both seats, and the whole thing ran in a transaction
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(bookingValues).toHaveBeenCalledTimes(1);
    expect(bookingSeatValues).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", seatId: "seat-1", priceCents: 2000 }),
    );
    expect(bookingSeatValues).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", seatId: "seat-2", priceCents: 1000 }),
    );
    expect(result).toEqual([
      { bookingId: "booking-1", seatId: "seat-1", status: "pending", ticketType: TicketType.FULL, priceCents: 2000 },
      {
        bookingId: "booking-1",
        seatId: "seat-2",
        status: "pending",
        ticketType: TicketType.HALF,
        priceCents: 1000,
      },
    ]);
  });

  it("should release the Valkey hold for every booked seat once the transaction commits", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    const bookingSeatValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: bookingValues })
      .mockReturnValueOnce({ values: bookingSeatValues })
      .mockReturnValueOnce({ values: bookingSeatValues });

    // ACT
    await service.createBookingForSeats(
      "session-1",
      [
        { seatId: "seat-1", ticketType: TicketType.FULL },
        { seatId: "seat-2", ticketType: TicketType.HALF, halfPriceDocument: "1234567890" },
      ],
      "user-1",
    );

    // ASSERT — the stale hold must not outlive the real Postgres row, or a later
    // cancellation would show the seat as still held instead of free
    expect(mockSeatingService.releaseHoldsForBookedSeats).toHaveBeenCalledWith("session-1", [
      "seat-1",
      "seat-2",
    ]);
  });

  it("should not release any hold when the booking transaction fails", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    mockDb.transaction.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));

    // ACT
    const result = service.createBookingForSeats(
      "session-1",
      [{ seatId: "seat-1", ticketType: TicketType.FULL }],
      "user-1",
    );

    // ASSERT
    await expect(result).rejects.toThrow(ConflictException);
    expect(mockSeatingService.releaseHoldsForBookedSeats).not.toHaveBeenCalled();
  });

  it("should throw ConflictException, not a raw database error, when a seat is already booked", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    mockDb.transaction.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));

    // ACT
    const result = service.createBookingForSeats(
      "session-1",
      [{ seatId: "seat-1", ticketType: TicketType.FULL }],
      "user-1",
    );

    // ASSERT
    await expect(result).rejects.toThrow(ConflictException);
  });

  it("should throw ConflictException when the unique violation is wrapped in a DrizzleQueryError's cause", async () => {
    // ARRANGE — matches how drizzle-orm actually surfaces the driver's PostgresError
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    const driverError = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockDb.transaction.mockRejectedValue(Object.assign(new Error("Failed query"), { cause: driverError }));

    // ACT
    const result = service.createBookingForSeats(
      "session-1",
      [{ seatId: "seat-1", ticketType: TicketType.FULL }],
      "user-1",
    );

    // ASSERT
    await expect(result).rejects.toThrow(ConflictException);
  });

  it("should rethrow unrelated database errors as-is instead of masking them as a conflict", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
    mockDb.transaction.mockRejectedValue(new Error("connection lost"));

    // ACT
    const result = service.createBookingForSeats(
      "session-1",
      [{ seatId: "seat-1", ticketType: TicketType.FULL }],
      "user-1",
    );

    // ASSERT
    await expect(result).rejects.toThrow("connection lost");
  });

  it("should throw NotFoundException when confirming a booking that doesn't exist", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.confirmBooking("missing-booking", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should throw NotFoundException when confirming another user's booking", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "someone-else",
      status: "pending",
    });

    // ACT
    const result = service.confirmBooking("booking-1", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should throw ConflictException when the booking is not pending", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "confirmed",
    });

    // ACT
    const result = service.confirmBooking("booking-1", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(ConflictException);
  });

  it("should flip a pending booking to confirmed", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "pending",
    });
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    // ACT
    const result = await service.confirmBooking("booking-1", "user-1");

    // ASSERT
    expect(result).toEqual({ bookingId: "booking-1", status: "confirmed" });
  });

  it("should broadcast a 'booked' seat update for every seat in the confirmed booking", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "pending",
    });
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });
    mockDb.query.bookingSeats.findMany.mockResolvedValue([{ seatId: "seat-1" }, { seatId: "seat-2" }]);

    // ACT
    await service.confirmBooking("booking-1", "user-1");

    // ASSERT
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(2);
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "booked" });
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-2", status: "booked" });
  });

  it("should send a confirmation email with the booking's details when confirmed", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst
      .mockResolvedValueOnce({ id: "booking-1", userId: "user-1", status: "pending" })
      .mockResolvedValueOnce({
        id: "booking-1",
        user: { email: "user@example.com" },
        session: {
          startsAt: new Date("2026-11-01T22:00:00Z"),
          movie: { title: "Dune" },
          room: { name: "Sala 1", cinema: { name: "Cine Centro" } },
        },
        seats: [{ priceCents: 2500, seat: { rowLabel: "A", seatNumber: 1 } }],
      });
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    // ACT
    await service.confirmBooking("booking-1", "user-1");

    // ASSERT
    expect(mockNotificationService.sendBookingConfirmationEmail).toHaveBeenCalledWith({
      to: "user@example.com",
      bookingId: "booking-1",
      movieTitle: "Dune",
      cinemaName: "Cine Centro",
      roomName: "Sala 1",
      startsAt: new Date("2026-11-01T22:00:00Z"),
      seats: [{ rowLabel: "A", seatNumber: 1 }],
      totalCents: 2500,
    });
  });

  it("should still confirm the booking when sending the confirmation email fails", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "pending",
    });
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });
    mockNotificationService.sendBookingConfirmationEmail.mockRejectedValue(new Error("SMTP down"));

    // ACT
    const result = await service.confirmBooking("booking-1", "user-1");

    // ASSERT
    expect(result).toEqual({ bookingId: "booking-1", status: "confirmed" });
  });

  it("should throw NotFoundException when cancelling a booking that doesn't exist", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.cancelBooking("missing-booking", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should throw NotFoundException when cancelling another user's booking", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "someone-else",
      status: "confirmed",
    });

    // ACT
    const result = service.cancelBooking("booking-1", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should throw ConflictException when the booking is not confirmed", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "pending",
    });

    // ACT
    const result = service.cancelBooking("booking-1", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(ConflictException);
  });

  it("should flip a confirmed booking to cancelled and broadcast its seats back to released", async () => {
    // ARRANGE
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      userId: "user-1",
      status: "confirmed",
    });
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "cancelled", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });
    mockDb.query.bookingSeats.findMany.mockResolvedValue([{ seatId: "seat-1" }, { seatId: "seat-2" }]);

    // ACT
    const result = await service.cancelBooking("booking-1", "user-1");

    // ASSERT
    expect(result).toEqual({ bookingId: "booking-1", status: "cancelled" });
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(2);
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
      seatId: "seat-1",
      status: "released",
    });
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
      seatId: "seat-2",
      status: "released",
    });
  });

  it("should flip a pending booking to confirmed and broadcast its seats as booked when the payment is approved", async () => {
    // ARRANGE
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });
    mockDb.query.bookingSeats.findMany.mockResolvedValue([{ seatId: "seat-1" }]);

    // ACT
    await service.confirmPaidBooking("booking-1");

    // ASSERT
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "booked" });
  });

  it("should send a confirmation email when the Mercado Pago payment is approved", async () => {
    // ARRANGE
    const where = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });
    mockDb.query.bookingSeats.findMany.mockResolvedValue([{ seatId: "seat-1" }]);
    mockDb.query.bookings.findFirst.mockResolvedValue({
      id: "booking-1",
      user: { email: "user@example.com" },
      session: {
        startsAt: new Date("2026-11-01T22:00:00Z"),
        movie: { title: "Dune" },
        room: { name: "Sala 1", cinema: { name: "Cine Centro" } },
      },
      seats: [{ priceCents: 2500, seat: { rowLabel: "A", seatNumber: 1 } }],
    });

    // ACT
    await service.confirmPaidBooking("booking-1");

    // ASSERT
    expect(mockNotificationService.sendBookingConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", bookingId: "booking-1" }),
    );
  });

  it("should do nothing when confirmPaidBooking is redelivered for a booking that's already past pending", async () => {
    // ARRANGE
    const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    // ACT
    await service.confirmPaidBooking("booking-1");

    // ASSERT
    expect(mockDb.query.bookingSeats.findMany).not.toHaveBeenCalled();
    expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
  });

  it("should cancel a pending booking and delete its seat rows when the payment fails", async () => {
    // ARRANGE
    const updateWhere = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "cancelled", sessionId: "session-1" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });
    const deleteWhere = stubDelete([{ seatId: "seat-1" }, { seatId: "seat-2" }]);

    // ACT
    await service.releaseFailedPaymentBooking("booking-1");

    // ASSERT
    expect(mockDb.delete).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
  });

  it("should broadcast every seat freed by a failed payment as released, after the transaction", async () => {
    // ARRANGE
    stubUpdates([{ id: "booking-1", status: "cancelled", sessionId: "session-1" }]);
    stubDelete([{ seatId: "seat-1" }, { seatId: "seat-2" }]);

    // ACT
    await service.releaseFailedPaymentBooking("booking-1");

    // ASSERT
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(2);
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "released" });
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-2", status: "released" });
  });

  it("should do nothing when releaseFailedPaymentBooking is redelivered for a booking that's already past pending", async () => {
    // ARRANGE
    const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) });

    // ACT
    await service.releaseFailedPaymentBooking("booking-1");

    // ASSERT
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("should only return confirmed bookings, mapped with session and seat details", async () => {
    // ARRANGE
    mockDb.query.bookings.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "confirmed",
        session: {
          id: "session-1",
          startsAt: new Date("2026-01-01T20:00:00.000Z"),
          priceCents: 2500,
          movie: { title: "Dune" },
          room: { name: "Sala 1", cinema: { name: "Cine A", city: "Recife" } },
        },
        seats: [{ seat: { rowLabel: "A", seatNumber: 1 } }],
      },
      {
        id: "booking-2",
        status: "pending",
        session: {
          id: "session-2",
          startsAt: new Date(),
          priceCents: 1000,
          movie: { title: "Other" },
          room: { name: "Sala 2", cinema: { name: "Cine B", city: "Recife" } },
        },
        seats: [],
      },
    ]);

    // ACT
    const result = await service.getMyBookings("user-1");

    // ASSERT
    expect(result).toEqual([
      {
        bookingId: "booking-1",
        status: "confirmed",
        session: {
          id: "session-1",
          startsAt: "2026-01-01T20:00:00.000Z",
          priceCents: 2500,
          movie: { title: "Dune" },
          room: { name: "Sala 1" },
          cinema: { name: "Cine A", city: "Recife" },
        },
        seats: [{ rowLabel: "A", seatNumber: 1 }],
      },
    ]);
  });

  describe("pending booking expiry", () => {
    it("should answer a plain conflict when the booking got confirmed between the read and the conditional update", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst
        .mockResolvedValueOnce({ id: "booking-1", userId: "user-1", status: "pending", pastDeadline: false })
        .mockResolvedValueOnce({ id: "booking-1", userId: "user-1", status: "confirmed", pastDeadline: false });
      stubUpdates([]);

      // ACT
      const result = service.confirmBooking("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      await expect(result).rejects.not.toThrow(BookingExpiredException);
    });

    it("should store expires_at as a DB-clock expression, never a Date from the API instance", async () => {
      // ARRANGE
      mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
      const bookingValues = stubBookingInserts(1);

      // ACT
      await service.createBookingForSeats("session-1", [{ seatId: "seat-1", ticketType: TicketType.FULL }], "user-1");

      // ASSERT
      const { expiresAt } = bookingValues.mock.calls[0][0];
      expect(expiresAt).toBeInstanceOf(SQL);
      expect(expiresAt).not.toBeInstanceOf(Date);
    });

    it("should broadcast every requested seat as booked once the booking is created", async () => {
      // ARRANGE
      mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
      stubBookingInserts(2);

      // ACT
      await service.createBookingForSeats(
        "session-1",
        [
          { seatId: "seat-1", ticketType: TicketType.FULL },
          { seatId: "seat-2", ticketType: TicketType.FULL },
        ],
        "user-1",
      );

      // ASSERT
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(2);
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "booked" });
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-2", status: "booked" });
    });

    it("should delete every seat of a lazily expired booking and release the ones not booked again", async () => {
      // ARRANGE — old booking held seat-1 (requested now) and seat-9 (not requested)
      mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
      stubUpdates([{ id: "old-booking" }]);
      const deleteWhere = stubDelete([
        { bookingId: "old-booking", seatId: "seat-1" },
        { bookingId: "old-booking", seatId: "seat-9" },
      ]);
      stubBookingInserts(1);

      // ACT
      await service.createBookingForSeats("session-1", [{ seatId: "seat-1", ticketType: TicketType.FULL }], "user-1");

      // ASSERT
      expect(deleteWhere).toHaveBeenCalledTimes(1);
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-9", status: "released" });
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", { seatId: "seat-1", status: "booked" });
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalledWith("session-1", {
        seatId: "seat-1",
        status: "released",
      });
    });

    it("should not delete any seat when no conflicting booking was expired", async () => {
      // ARRANGE
      mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1", priceCents: 2000 });
      stubBookingInserts(1);

      // ACT
      await service.createBookingForSeats("session-1", [{ seatId: "seat-1", ticketType: TicketType.FULL }], "user-1");

      // ASSERT
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it.each([
      { status: "expired", pastDeadline: false },
      { status: "pending", pastDeadline: true },
    ])("should refuse to confirm a booking with status $status and pastDeadline $pastDeadline as BOOKING_EXPIRED", async (booking) => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue({ id: "booking-1", userId: "user-1", ...booking });

      // ACT
      const result = service.confirmBooking("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(BookingExpiredException);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should answer 409 with code BOOKING_EXPIRED and the user-facing message", () => {
      // ARRANGE
      const exception = new BookingExpiredException();

      // ACT
      const body = exception.getResponse();

      // ASSERT
      expect(exception.getStatus()).toBe(409);
      expect(body).toEqual({
        statusCode: 409,
        code: "BOOKING_EXPIRED",
        message: "Reserva expirada. Escolha os assentos novamente.",
      });
    });

    it("should refuse to confirm when the booking expires between the read and the conditional update", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst
        .mockResolvedValueOnce({ id: "booking-1", userId: "user-1", status: "pending", pastDeadline: false })
        .mockResolvedValueOnce({ id: "booking-1", userId: "user-1", status: "pending", pastDeadline: true });
      stubUpdates([]);

      // ACT
      const result = service.confirmBooking("booking-1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(BookingExpiredException);
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
    });

    it("should flag the booking for refund review and log a warning when an approved payment hits an expired booking", async () => {
      // ARRANGE — not pending anymore, but the expired-booking flag update matches
      stubUpdates([], [{ id: "booking-1" }]);
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      // ACT
      await service.confirmPaidBooking("booking-1", { externalPaymentId: "mp-1", amountCents: 3000 });

      // ASSERT
      const flagSet = mockDb.update.mock.results[1].value.set;
      expect(flagSet).toHaveBeenCalledWith({ needsRefundReview: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining("bookingId=booking-1"));
      expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining("externalPaymentId=mp-1"));
      expect(mockNotificationService.sendBookingConfirmationEmail).not.toHaveBeenCalled();
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("should not warn again when the expired booking was already flagged for refund review", async () => {
      // ARRANGE
      stubUpdates([], []);
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      // ACT
      await service.confirmPaidBooking("booking-1", { externalPaymentId: "mp-1", amountCents: 3000 });

      // ASSERT
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
