import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
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
}
