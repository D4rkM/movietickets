import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { BookingService } from "./booking.service";
import { TicketType } from "./dto/book-seat.dto";

describe("BookingService", () => {
  const mockDb = {
    query: { sessions: { findFirst: jest.fn() } },
    insert: jest.fn(),
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
});
