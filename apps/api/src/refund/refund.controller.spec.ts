import { FastifyRequest } from "fastify";
import { RefundController } from "./refund.controller";
import { RefundService } from "./refund.service";

describe("RefundController", () => {
  it("should delegate the cancellation to RefundService with the booking id and the requesting user", async () => {
    // ARRANGE
    const refundService = { cancelWithRefund: jest.fn().mockResolvedValue({ bookingId: "booking-1" }) };
    const controller = new RefundController(refundService as unknown as RefundService);
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;

    // ACT
    const result = await controller.cancelBooking("booking-1", request);

    // ASSERT
    expect(refundService.cancelWithRefund).toHaveBeenCalledWith("booking-1", "user-1");
    expect(result).toEqual({ bookingId: "booking-1" });
  });
});
