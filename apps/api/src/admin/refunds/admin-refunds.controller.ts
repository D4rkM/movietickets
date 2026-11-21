import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { RefundService } from "../../refund/refund.service";
import { RefundReviewQueriesService } from "./refund-review-queries.service";

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminRefundsController {
  constructor(
    private readonly queries: RefundReviewQueriesService,
    private readonly refundService: RefundService,
  ) {}

  @Get("refunds/review")
  listReviewQueue() {
    return this.queries.listReviewQueue();
  }

  @Post("bookings/:id/refund")
  @HttpCode(HttpStatus.OK)
  refundBooking(@Param("id", ParseUUIDPipe) bookingId: string, @Req() request: FastifyRequest) {
    return this.refundService.requestAdminRefund(bookingId, request.user!.sub);
  }
}
