import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { BookingService } from "./booking.service";

describe("BookingService", () => {
  const mockDb = {
    query: { sessions: { findFirst: jest.fn() }, bookings: { findFirst: jest.fn() } },
    insert: jest.fn(),
    update: jest.fn(),
  };

  let service: BookingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [BookingService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();

    service = moduleRef.get(BookingService);
  });

  it("should throw NotFoundException when the session does not exist", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.createBooking("missing-session", "seat-1", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should insert a pending booking and a booking_seat linking the chosen seat", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue({ id: "session-1" });
    const bookingValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: "booking-1", status: "pending" }]),
    });
    const bookingSeatValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: bookingValues })
      .mockReturnValueOnce({ values: bookingSeatValues });

    // ACT
    const result = await service.createBooking("session-1", "seat-1", "user-1");

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
    });
    expect(result).toEqual({ bookingId: "booking-1", seatId: "seat-1", status: "pending" });
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
});
