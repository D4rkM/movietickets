import { Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RefundService } from "./refund.service";

@Controller("bookings")
@UseGuards(JwtAuthGuard)
export class RefundController {
  constructor(private readonly refundService: RefundService) {}

  /** Cancels the user's confirmed booking, refunding its approved payment in full (docs/flows/refund/spec.md). */
  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancelBooking(@Param("id") bookingId: string, @Req() request: FastifyRequest) {
    return this.refundService.cancelWithRefund(bookingId, request.user!.sub);
  }
}
