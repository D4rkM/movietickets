import { Module } from "@nestjs/common";
import { AuthTokenModule } from "../auth/auth-token.module";
import { AdminCinemasController } from "./cinemas/admin-cinemas.controller";
import { CinemaCommandsService } from "./cinemas/cinema-commands.service";
import { CinemaQueriesService } from "./cinemas/cinema-queries.service";
import { AdminMoviesController } from "./movies/admin-movies.controller";
import { MovieCommandsService } from "./movies/movie-commands.service";
import { MovieQueriesService } from "./movies/movie-queries.service";
import { AdminRoomsController } from "./rooms/admin-rooms.controller";
import { RoomCommandsService } from "./rooms/room-commands.service";
import { RoomQueriesService } from "./rooms/room-queries.service";
import { AdminSessionsController } from "./sessions/admin-sessions.controller";
import { SessionActivityService } from "./sessions/session-activity.service";
import { SessionCommandsService } from "./sessions/session-commands.service";
import { SessionQueriesService } from "./sessions/session-queries.service";

/**
 * Admin back office under `/admin/*`: movies, cinemas, rooms and sessions.
 * Every controller requires a user token with `role: "admin"`
 * (JwtAuthGuard + RolesGuard). Commands and queries are split per resource
 * (CQRS light, no event store).
 */
@Module({
  imports: [AuthTokenModule],
  controllers: [AdminMoviesController, AdminCinemasController, AdminRoomsController, AdminSessionsController],
  providers: [
    MovieQueriesService,
    MovieCommandsService,
    CinemaQueriesService,
    CinemaCommandsService,
    RoomQueriesService,
    RoomCommandsService,
    SessionQueriesService,
    SessionCommandsService,
    SessionActivityService,
  ],
})
export class AdminModule {}
