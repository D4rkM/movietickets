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
import { SessionCommandsService } from "./sessions/session-commands.service";
import { SessionQueriesService } from "./sessions/session-queries.service";

const queriesMock = () => ({ list: jest.fn().mockReturnValue("list"), getById: jest.fn().mockReturnValue("one") });
const commandsMock = () => ({
  create: jest.fn().mockReturnValue("created"),
  update: jest.fn().mockReturnValue("updated"),
  delete: jest.fn().mockReturnValue("deleted"),
});

describe("Admin controllers", () => {
  it("should delegate movie routes to the movie queries and commands", () => {
    // ARRANGE
    const queries = queriesMock();
    const commands = commandsMock();
    const controller = new AdminMoviesController(
      queries as unknown as MovieQueriesService,
      commands as unknown as MovieCommandsService,
    );
    const dto = { title: "Filme", durationMinutes: 90 };

    // ACT
    const results = [
      controller.list(),
      controller.getById("id"),
      controller.create(dto),
      controller.update("id", dto),
      controller.delete("id"),
    ];

    // ASSERT
    expect(results).toEqual(["list", "one", "created", "updated", "deleted"]);
    expect(commands.update).toHaveBeenCalledWith("id", dto);
  });

  it("should delegate cinema routes to the cinema queries and commands", () => {
    // ARRANGE
    const queries = queriesMock();
    const commands = commandsMock();
    const controller = new AdminCinemasController(
      queries as unknown as CinemaQueriesService,
      commands as unknown as CinemaCommandsService,
    );
    const dto = { name: "Cine", address: "Rua", city: "Santos" };

    // ACT
    const results = [controller.list(), controller.getById("id"), controller.create(dto), controller.update("id", dto)];

    // ASSERT
    expect(results).toEqual(["list", "one", "created", "updated"]);
  });

  it("should delegate room routes, passing the cinema filter to the list", () => {
    // ARRANGE
    const queries = queriesMock();
    const commands = commandsMock();
    const controller = new AdminRoomsController(
      queries as unknown as RoomQueriesService,
      commands as unknown as RoomCommandsService,
    );
    const dto = { cinemaId: "c", name: "Sala", rows: 2, seatsPerRow: 2 };

    // ACT
    const results = [
      controller.list({ cinemaId: "c" }),
      controller.getById("id"),
      controller.create(dto),
      controller.update("id", { name: "Sala 2" }),
      controller.delete("id"),
    ];

    // ASSERT
    expect(results).toEqual(["list", "one", "created", "updated", "deleted"]);
    expect(queries.list).toHaveBeenCalledWith("c");
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
  ])("should list sessions with includePast=%p as %p", (includePast, expected) => {
    // ARRANGE
    const queries = queriesMock();
    const controller = new AdminSessionsController(
      queries as unknown as SessionQueriesService,
      commandsMock() as unknown as SessionCommandsService,
    );

    // ACT
    controller.list({ includePast });

    // ASSERT
    expect(queries.list).toHaveBeenCalledWith(expected);
  });

  it("should delegate session writes to the session commands", () => {
    // ARRANGE
    const queries = queriesMock();
    const commands = commandsMock();
    const controller = new AdminSessionsController(
      queries as unknown as SessionQueriesService,
      commands as unknown as SessionCommandsService,
    );
    const dto = { movieId: "m", roomId: "r", startsAt: "2030-01-10T19:00:00Z", priceCents: 3000 };

    // ACT
    const results = [
      controller.getById("id"),
      controller.create(dto),
      controller.update("id", { priceCents: 1 }),
      controller.delete("id"),
    ];

    // ASSERT
    expect(results).toEqual(["one", "created", "updated", "deleted"]);
  });
});
