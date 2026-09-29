import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SeatingService } from "./seating.service";

@Controller("sessions")
@UseGuards(JwtAuthGuard)
export class SeatingController {
  constructor(private readonly seatingService: SeatingService) {}

  @Get(":id/seats")
  getSeatMap(@Param("id") sessionId: string, @Req() request: FastifyRequest) {
    return this.seatingService.getSeatMap(sessionId, request.user!.sub);
  }

  @Post(":id/seats/:seatId/hold")
  @HttpCode(HttpStatus.OK)
  holdSeat(
    @Param("id") sessionId: string,
    @Param("seatId") seatId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.seatingService.holdSeat(sessionId, seatId, request.user!.sub);
  }

  @Delete(":id/seats/:seatId/hold")
  releaseSeat(
    @Param("id") sessionId: string,
    @Param("seatId") seatId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.seatingService.releaseSeat(sessionId, seatId, request.user!.sub);
  }

  @Delete(":id/holds")
  releaseAllHolds(@Param("id") sessionId: string, @Req() request: FastifyRequest) {
    return this.seatingService.releaseAllHoldsForUser(sessionId, request.user!.sub);
  }
}
