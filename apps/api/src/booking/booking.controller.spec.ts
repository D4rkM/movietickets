import { FastifyRequest } from "fastify";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";

describe("BookingController", () => {
  const mockBookingService = { createBooking: jest.fn() };
  let controller: BookingController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new BookingController(mockBookingService as unknown as BookingService);
  });

  it("should delegate to BookingService with session id, seat id and the requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockBookingService.createBooking.mockResolvedValue({
      bookingId: "booking-1",
      seatId: "seat-1",
      status: "pending",
    });

    // ACT
    const result = await controller.createBooking("session-1", "seat-1", request);

    // ASSERT
    expect(mockBookingService.createBooking).toHaveBeenCalledWith("session-1", "seat-1", "user-1");
    expect(result).toEqual({ bookingId: "booking-1", seatId: "seat-1", status: "pending" });
  });
});
