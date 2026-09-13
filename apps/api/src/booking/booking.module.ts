import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { MyBookingsController } from "./my-bookings.controller";

@Module({
  imports: [AuthModule],
  controllers: [BookingController, MyBookingsController],
  providers: [BookingService],
})
export class BookingModule {}
