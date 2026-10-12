import { Module } from "@nestjs/common";
import { mailTransportProvider } from "./mail-transport.provider";
import { NotificationService } from "./notification.service";

@Module({
  providers: [NotificationService, mailTransportProvider],
  exports: [NotificationService],
})
export class NotificationModule {}
