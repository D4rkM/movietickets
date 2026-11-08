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
import { CreateRoomDto, ListRoomsQueryDto, UpdateRoomDto } from "./dto/room.dto";
import { RoomCommandsService } from "./room-commands.service";
import { RoomQueriesService } from "./room-queries.service";

@Controller("admin/rooms")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminRoomsController {
  constructor(
    private readonly queries: RoomQueriesService,
    private readonly commands: RoomCommandsService,
  ) {}

  @Get()
  list(@Query() query: ListRoomsQueryDto) {
    return this.queries.list(query.cinemaId);
  }

  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.queries.getById(id);
  }

  @Post()
  create(@Body() dto: CreateRoomDto) {
    return this.commands.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) {
    return this.commands.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param("id", ParseUUIDPipe) id: string) {
    return this.commands.delete(id);
  }
}
