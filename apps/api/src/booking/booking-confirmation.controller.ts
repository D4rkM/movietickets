import { Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BookingService } from "./booking.service";
import { TestRoutesGuard } from "./test-routes.guard";

// Mocked payment confirmation: only exists with ENABLE_TEST_ROUTES=true (docs/flows/test-routes/spec.md).
@Controller("bookings")
@UseGuards(TestRoutesGuard, JwtAuthGuard)
export class BookingConfirmationController {
  constructor(private readonly bookingService: BookingService) {}

  @Post(":id/confirm")
  @HttpCode(HttpStatus.OK)
  confirmBooking(@Param("id") bookingId: string, @Req() request: FastifyRequest) {
    return this.bookingService.confirmBooking(bookingId, request.user!.sub);
  }
}
