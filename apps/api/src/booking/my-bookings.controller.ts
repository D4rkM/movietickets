import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BookingService } from "./booking.service";

@Controller("bookings")
@UseGuards(JwtAuthGuard)
export class MyBookingsController {
  constructor(private readonly bookingService: BookingService) {}

  @Get("mine")
  getMyBookings(@Req() request: FastifyRequest) {
    return this.bookingService.getMyBookings(request.user!.sub);
  }
}
