import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingConfirmationController } from "./booking-confirmation.controller";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";

@Module({
  imports: [AuthModule],
  controllers: [BookingController, BookingConfirmationController],
  providers: [BookingService],
})
export class BookingModule {}
