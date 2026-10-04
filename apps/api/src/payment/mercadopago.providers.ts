import { ConfigService } from "@nestjs/config";
import { MercadoPagoConfig, Payment, Preference } from "mercadopago";

export const PREFERENCE_CLIENT = Symbol("PREFERENCE_CLIENT");
export const PAYMENT_CLIENT = Symbol("PAYMENT_CLIENT");

function buildConfig(config: ConfigService): MercadoPagoConfig {
  return new MercadoPagoConfig({ accessToken: config.getOrThrow<string>("MERCADOPAGO_ACCESS_TOKEN") });
}

export const mercadoPagoProviders = [
  {
    provide: PREFERENCE_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new Preference(buildConfig(config)),
  },
  {
    provide: PAYMENT_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => new Payment(buildConfig(config)),
  },
];
