import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { CreateMovieDto, UpdateMovieDto } from "./dto/movie.dto";
import { MovieCommandsService } from "./movie-commands.service";
import { MovieQueriesService } from "./movie-queries.service";

@Controller("admin/movies")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminMoviesController {
  constructor(
    private readonly queries: MovieQueriesService,
    private readonly commands: MovieCommandsService,
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
  create(@Body() dto: CreateMovieDto) {
    return this.commands.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateMovieDto) {
    return this.commands.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param("id", ParseUUIDPipe) id: string) {
    return this.commands.delete(id);
  }
}
