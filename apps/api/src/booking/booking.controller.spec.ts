import { FastifyRequest } from "fastify";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { BookSeatDto, TicketType } from "./dto/book-seat.dto";
import { BookSeatsDto } from "./dto/book-seats.dto";

describe("BookingController", () => {
  const mockBookingService = { createBooking: jest.fn(), createBookingForSeats: jest.fn() };
  let controller: BookingController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new BookingController(mockBookingService as unknown as BookingService);
  });

  it("should delegate to BookingService with session id, seat id, ticket choice and the requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    const dto: BookSeatDto = { ticketType: TicketType.FULL };
    mockBookingService.createBooking.mockResolvedValue({
      bookingId: "booking-1",
      seatId: "seat-1",
      status: "pending",
      ticketType: TicketType.FULL,
      priceCents: 2500,
    });

    // ACT
    const result = await controller.createBooking("session-1", "seat-1", dto, request);

    // ASSERT
    expect(mockBookingService.createBooking).toHaveBeenCalledWith(
      "session-1",
      "seat-1",
      "user-1",
      TicketType.FULL,
      undefined,
    );
    expect(result).toEqual({
      bookingId: "booking-1",
      seatId: "seat-1",
      status: "pending",
      ticketType: TicketType.FULL,
      priceCents: 2500,
    });
  });

  it("should delegate to BookingService.createBookingForSeats with session id, seat list and the requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    const dto: BookSeatsDto = {
      seats: [
        { seatId: "seat-1", ticketType: TicketType.FULL },
        { seatId: "seat-2", ticketType: TicketType.HALF, halfPriceDocument: "1234567890" },
      ],
    };
    mockBookingService.createBookingForSeats.mockResolvedValue([
      { bookingId: "booking-1", seatId: "seat-1", status: "pending", ticketType: TicketType.FULL, priceCents: 2500 },
      {
        bookingId: "booking-1",
        seatId: "seat-2",
        status: "pending",
        ticketType: TicketType.HALF,
        priceCents: 1250,
      },
    ]);

    // ACT
    const result = await controller.createBookingForSeats("session-1", dto, request);

    // ASSERT
    expect(mockBookingService.createBookingForSeats).toHaveBeenCalledWith("session-1", dto.seats, "user-1");
    expect(result).toHaveLength(2);
  });
});
