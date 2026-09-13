import { FastifyRequest } from "fastify";
import { BookingService } from "./booking.service";
import { MyBookingsController } from "./my-bookings.controller";

describe("MyBookingsController", () => {
  const mockBookingService = { getMyBookings: jest.fn() };
  let controller: MyBookingsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new MyBookingsController(mockBookingService as unknown as BookingService);
  });

  it("should delegate to BookingService with the requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockBookingService.getMyBookings.mockResolvedValue([]);

    // ACT
    const result = await controller.getMyBookings(request);

    // ASSERT
    expect(mockBookingService.getMyBookings).toHaveBeenCalledWith("user-1");
    expect(result).toEqual([]);
  });
});
