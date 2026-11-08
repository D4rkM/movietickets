import { ConfigService } from "@nestjs/config";
import { MercadoPagoConfig, Payment } from "mercadopago";

export const PAYMENT_CLIENT = Symbol("PAYMENT_CLIENT");

function buildConfig(config: ConfigService): MercadoPagoConfig {
  return new MercadoPagoConfig({ accessToken: config.getOrThrow<string>("MERCADOPAGO_ACCESS_TOKEN") });
}

export const mercadoPagoProviders = [
  {
    provide: PAYMENT_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new Payment(buildConfig(config)),
  },
];
