import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingModule } from "../booking/booking.module";
import { MercadoPagoModule } from "../mercadopago/mercadopago.module";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";

@Module({
  imports: [AuthModule, BookingModule, MercadoPagoModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
