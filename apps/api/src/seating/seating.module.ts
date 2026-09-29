import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SeatingController } from "./seating.controller";
import { SeatingGateway } from "./seating.gateway";
import { SeatingService } from "./seating.service";

@Module({
  imports: [AuthModule],
  controllers: [SeatingController],
  providers: [SeatingService, SeatingGateway],
  exports: [SeatingGateway],
})
export class SeatingModule {}
