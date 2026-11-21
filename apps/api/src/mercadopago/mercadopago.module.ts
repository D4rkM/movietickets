import { Module } from "@nestjs/common";
import { mercadoPagoProviders, PAYMENT_CLIENT, REFUND_CLIENT } from "./mercadopago.providers";

/**
 * Mercado Pago SDK clients (`Payment`, `PaymentRefund`), shared by PaymentModule
 * and RefundModule so neither has to import the other.
 */
@Module({
  providers: [...mercadoPagoProviders],
  exports: [PAYMENT_CLIENT, REFUND_CLIENT],
})
export class MercadoPagoModule {}
