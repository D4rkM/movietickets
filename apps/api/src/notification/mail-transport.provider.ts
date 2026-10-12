import { ConfigService } from "@nestjs/config";
import { createTransport, Transporter } from "nodemailer";

export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");

export const mailTransportProvider = {
  provide: MAIL_TRANSPORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Transporter =>
    createTransport({
      host: config.get<string>("SMTP_HOST", "localhost"),
      port: config.get<number>("SMTP_PORT", 1025),
      // Mailpit (dev) accepts any connection with no TLS/auth; a real provider
      // in production would need secure/auth wired in from env too.
      secure: false,
    }),
};
