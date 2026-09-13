import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";

@Module({
  imports: [AuthModule],
  controllers: [BookingController],
  providers: [BookingService],
})
export class BookingModule {}
