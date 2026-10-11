import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { mercadoPagoProviders } from "./mercadopago.providers";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";

@Module({
  imports: [AuthModule, BookingModule],
  controllers: [PaymentController],
  providers: [PaymentService, ...mercadoPagoProviders],
})
export class PaymentModule {}
