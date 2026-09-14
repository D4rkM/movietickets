import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { BookingService } from "./booking.service";
import { TicketType } from "./dto/book-seat.dto";

describe("BookingService", () => {
  const mockDb = {
    query: {
      sessions: { findFirst: jest.fn() },
      bookings: { findFirst: jest.fn(), findMany: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  };

  let service: BookingService;

  // Wires mockDb.transaction to run the callback against a tx that shares
  // mockDb.insert, so existing insert-mock setups keep working unchanged.
  function stubTransaction() {
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) =>
      callback(mockDb),
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    stubTransaction();

    const moduleRef = await Test.createTestingModule({
      providers: [BookingService, { provide: DRIZZLE, useValue: mockDb }],
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
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "confirmed" }]),
    });
    mockDb.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where }) });

    // ACT
    const result = await service.confirmBooking("booking-1", "user-1");

    // ASSERT
    expect(result).toEqual({ bookingId: "booking-1", status: "confirmed" });
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
});
