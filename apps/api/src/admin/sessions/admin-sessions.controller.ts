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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { CreateSessionDto, ListSessionsQueryDto, UpdateSessionDto } from "./dto/session.dto";
import { SessionCommandsService } from "./session-commands.service";
import { SessionQueriesService } from "./session-queries.service";

@Controller("admin/sessions")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminSessionsController {
  constructor(
    private readonly queries: SessionQueriesService,
    private readonly commands: SessionCommandsService,
  ) {}

  @Get()
  list(@Query() query: ListSessionsQueryDto) {
    return this.queries.list(query.includePast === "true");
  }

  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.queries.getById(id);
  }

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.commands.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateSessionDto) {
    return this.commands.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param("id", ParseUUIDPipe) id: string) {
    return this.commands.delete(id);
  }
}
