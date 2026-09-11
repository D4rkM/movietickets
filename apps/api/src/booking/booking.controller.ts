import { Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BookingService } from "./booking.service";

@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post(":id/seats/:seatId/book")
  @HttpCode(HttpStatus.CREATED)
  createBooking(
    @Param("id") sessionId: string,
    @Param("seatId") seatId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.bookingService.createBooking(sessionId, seatId, request.user!.sub);
  }
}
