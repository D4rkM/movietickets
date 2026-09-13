import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { BookingService } from "./booking.service";

describe("BookingService", () => {
  const mockDb = {
    query: { sessions: { findFirst: jest.fn() }, bookings: { findMany: jest.fn() } },
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
