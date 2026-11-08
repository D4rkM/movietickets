import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import {
  MercadoPagoNotification,
  MercadoPagoWebhookQuery,
  PaymentService,
} from "./payment.service";

@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get("bookings/:id/payment-summary")
  @UseGuards(JwtAuthGuard)
  getPaymentSummary(@Param("id") bookingId: string, @Req() request: FastifyRequest) {
    return this.paymentService.getPaymentSummary(bookingId, request.user!.sub);
  }

  @Post("bookings/:id/payments")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  createPayment(
    @Param("id") bookingId: string,
    @Body() dto: CreatePaymentDto,
    @Req() request: FastifyRequest,
  ) {
    return this.paymentService.createPayment(bookingId, request.user!.sub, dto);
  }

  @Post("payments/webhook")
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() notification: MercadoPagoNotification,
    @Query() query: MercadoPagoWebhookQuery,
  ): Promise<void> {
    await this.paymentService.handleWebhook(notification, query);
  }
}
