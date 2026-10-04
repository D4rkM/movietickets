import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { MercadoPagoNotification, PaymentService } from "./payment.service";

@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post("bookings/:id/checkout")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  createCheckout(@Param("id") bookingId: string, @Req() request: FastifyRequest) {
    return this.paymentService.createCheckout(bookingId, request.user!.sub);
  }

  @Post("payments/webhook")
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() notification: MercadoPagoNotification): Promise<void> {
    await this.paymentService.handleWebhook(notification);
  }
}
