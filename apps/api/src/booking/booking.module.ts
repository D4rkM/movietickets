import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { SeatingModule } from "../seating/seating.module";
import { BookingConfirmationController } from "./booking-confirmation.controller";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { MyBookingsController } from "./my-bookings.controller";

@Module({
  imports: [AuthModule, SeatingModule, NotificationModule],
  controllers: [BookingController, BookingConfirmationController, MyBookingsController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
