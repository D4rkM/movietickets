import { ConfigService } from "@nestjs/config";
import { MercadoPagoConfig, Payment, PaymentRefund } from "mercadopago";

export const PAYMENT_CLIENT = Symbol("PAYMENT_CLIENT");
export const REFUND_CLIENT = Symbol("REFUND_CLIENT");

function buildConfig(config: ConfigService): MercadoPagoConfig {
  return new MercadoPagoConfig({ accessToken: config.getOrThrow<string>("MERCADOPAGO_ACCESS_TOKEN") });
}

export const mercadoPagoProviders = [
  {
    provide: PAYMENT_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new Payment(buildConfig(config)),
  },
  {
    provide: REFUND_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new PaymentRefund(buildConfig(config)),
  },
];
