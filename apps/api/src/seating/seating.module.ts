import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SeatingController } from "./seating.controller";
import { SeatingService } from "./seating.service";

@Module({
  imports: [AuthModule],
  controllers: [SeatingController],
  providers: [SeatingService],
})
export class SeatingModule {}
