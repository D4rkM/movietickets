import { Module } from "@nestjs/common";
import { TelemetryModule } from "../telemetry/telemetry.module";
import { AuthTokenModule } from "../auth/auth-token.module";
import { BookingModule } from "../booking/booking.module";
import { MercadoPagoModule } from "../mercadopago/mercadopago.module";
import { NotificationModule } from "../notification/notification.module";
import { RefundController } from "./refund.controller";
import { RefundService } from "./refund.service";

/**
 * Refunds (docs/flows/refund/spec.md): customer cancellation with refund and
 * the shared RefundService used by the payment webhook and the admin review
 * queue. Doesn't import PaymentModule (PaymentModule imports this one).
 */
@Module({
  imports: [AuthTokenModule, BookingModule, NotificationModule, MercadoPagoModule, TelemetryModule],
  controllers: [RefundController],
  providers: [RefundService],
  exports: [RefundService],
})
export class RefundModule {}
