import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BookingService } from "./booking.service";
import { BookSeatDto } from "./dto/book-seat.dto";
import { BookSeatsDto } from "./dto/book-seats.dto";

@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post(":id/seats/:seatId/book")
  @HttpCode(HttpStatus.CREATED)
  createBooking(
    @Param("id") sessionId: string,
    @Param("seatId") seatId: string,
    @Body() dto: BookSeatDto,
    @Req() request: FastifyRequest,
  ) {
    return this.bookingService.createBooking(
      sessionId,
      seatId,
      request.user!.sub,
      dto.ticketType,
      dto.halfPriceDocument,
    );
  }

  /**
   * Books every seat in one atomic request — used by checkout when a user
   * pays for several seats at once, so a mid-request failure leaves nothing
   * booked instead of a partial set of seats.
   */
  @Post(":id/book")
  @HttpCode(HttpStatus.CREATED)
  createBookingForSeats(
    @Param("id") sessionId: string,
    @Body() dto: BookSeatsDto,
    @Req() request: FastifyRequest,
  ) {
    return this.bookingService.createBookingForSeats(sessionId, dto.seats, request.user!.sub);
  }
}
