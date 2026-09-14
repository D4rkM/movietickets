import { FastifyRequest } from "fastify";
import { BookingConfirmationController } from "./booking-confirmation.controller";
import { BookingService } from "./booking.service";

describe("BookingConfirmationController", () => {
  const mockBookingService = { confirmBooking: jest.fn() };
  let controller: BookingConfirmationController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new BookingConfirmationController(mockBookingService as unknown as BookingService);
  });

  it("should delegate to BookingService with the booking id and the requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockBookingService.confirmBooking.mockResolvedValue({ bookingId: "booking-1", status: "confirmed" });

    // ACT
    const result = await controller.confirmBooking("booking-1", request);

    // ASSERT
    expect(mockBookingService.confirmBooking).toHaveBeenCalledWith("booking-1", "user-1");
    expect(result).toEqual({ bookingId: "booking-1", status: "confirmed" });
  });
});
