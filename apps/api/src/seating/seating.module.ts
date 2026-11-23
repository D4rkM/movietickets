import { Module } from "@nestjs/common";
import { TelemetryModule } from "../telemetry/telemetry.module";
import { AuthTokenModule } from "../auth/auth-token.module";
import { HoldExpiryListener } from "./hold-expiry.listener";
import { HoldTransferService } from "./hold-transfer.service";
import { SeatingController } from "./seating.controller";
import { SeatingGateway } from "./seating.gateway";
import { SeatingService } from "./seating.service";

@Module({
  imports: [AuthTokenModule, TelemetryModule],
  controllers: [SeatingController],
  providers: [SeatingService, SeatingGateway, HoldExpiryListener, HoldTransferService],
  exports: [SeatingGateway, SeatingService, HoldTransferService],
})
export class SeatingModule {}
