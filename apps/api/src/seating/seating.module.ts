import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HoldExpiryListener } from "./hold-expiry.listener";
import { SeatingController } from "./seating.controller";
import { SeatingGateway } from "./seating.gateway";
import { SeatingService } from "./seating.service";

@Module({
  imports: [AuthModule],
  controllers: [SeatingController],
  providers: [SeatingService, SeatingGateway, HoldExpiryListener],
  exports: [SeatingGateway],
})
export class SeatingModule {}
