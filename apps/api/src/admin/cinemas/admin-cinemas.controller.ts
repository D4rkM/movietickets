import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { CinemaCommandsService } from "./cinema-commands.service";
import { CinemaQueriesService } from "./cinema-queries.service";
import { CreateCinemaDto, UpdateCinemaDto } from "./dto/cinema.dto";

/** List, create and edit only: deleting a cinema is out of scope. */
@Controller("admin/cinemas")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminCinemasController {
  constructor(
    private readonly queries: CinemaQueriesService,
    private readonly commands: CinemaCommandsService,
  ) {}

  @Get()
  list() {
    return this.queries.list();
  }

  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.queries.getById(id);
  }

  @Post()
  create(@Body() dto: CreateCinemaDto) {
    return this.commands.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCinemaDto) {
    return this.commands.update(id, dto);
  }
}
