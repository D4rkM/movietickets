import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { CatalogService } from "./catalog.service";

describe("CatalogService", () => {
  const mockDb = {
    query: {
      movies: { findMany: jest.fn() },
      cinemas: { findMany: jest.fn() },
    },
  };

  let service: CatalogService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [CatalogService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();

    service = moduleRef.get(CatalogService);
  });

  it("should map movies and their sessions to the catalog response shape", async () => {
    // ARRANGE
    mockDb.query.movies.findMany.mockResolvedValue([
      {
        id: "movie-1",
        title: "Dune",
        synopsis: "Sci-fi epic",
        durationMinutes: 155,
        posterUrl: null,
        rating: "14",
        sessions: [
          {
            id: "session-1",
            startsAt: new Date("2026-01-01T20:00:00.000Z"),
            priceCents: 3000,
            room: {
              id: "room-1",
              name: "Sala 1",
              cinema: { id: "cinema-1", name: "Cine A", city: "Recife" },
            },
          },
        ],
      },
    ]);

    // ACT
    const result = await service.listMovies();

    // ASSERT
    expect(result).toEqual([
      {
        id: "movie-1",
        title: "Dune",
        synopsis: "Sci-fi epic",
        durationMinutes: 155,
        posterUrl: null,
        rating: "14",
        sessions: [
          {
            id: "session-1",
            startsAt: "2026-01-01T20:00:00.000Z",
            priceCents: 3000,
            room: { id: "room-1", name: "Sala 1" },
            cinema: { id: "cinema-1", name: "Cine A", city: "Recife" },
          },
        ],
      },
    ]);
  });

  it("should return an empty sessions array for a movie with no upcoming sessions", async () => {
    // ARRANGE
    mockDb.query.movies.findMany.mockResolvedValue([
      {
        id: "movie-2",
        title: "Old Movie",
        synopsis: null,
        durationMinutes: 90,
        posterUrl: null,
        rating: null,
        sessions: [],
      },
    ]);

    // ACT
    const result = await service.listMovies();

    // ASSERT
    expect(result[0].sessions).toEqual([]);
  });

  describe("filters", () => {
    const movieWithSession = {
      id: "movie-1",
      title: "Dune",
      synopsis: null,
      durationMinutes: 155,
      posterUrl: null,
      rating: null,
      sessions: [
        {
          id: "session-1",
          startsAt: new Date("2026-01-01T20:00:00.000Z"),
          priceCents: 3000,
          room: { id: "room-1", name: "Sala 1", cinema: { id: "cinema-1", name: "Cine A", city: "Recife" } },
        },
      ],
    };

    it("should drop movies left with no sessions once a filter is applied", async () => {
      // ARRANGE — the mocked findMany already simulates the DB applying the where clause
      mockDb.query.movies.findMany.mockResolvedValue([{ ...movieWithSession, sessions: [] }]);
      mockDb.query.cinemas.findMany.mockResolvedValue([{ id: "cinema-1", rooms: [{ id: "room-1" }] }]);

      // ACT
      const result = await service.listMovies({ city: "Recife" });

      // ASSERT
      expect(result).toEqual([]);
    });

    it("should resolve a city filter to that city's room ids and pass them down as roomId filters", async () => {
      // ARRANGE
      mockDb.query.cinemas.findMany.mockResolvedValue([
        { id: "cinema-1", rooms: [{ id: "room-1" }, { id: "room-2" }] },
      ]);
      mockDb.query.movies.findMany.mockResolvedValue([movieWithSession]);

      // ACT
      await service.listMovies({ city: "Recife" });

      // ASSERT
      const sessionsArg = mockDb.query.movies.findMany.mock.calls[0][0].with.sessions;
      expect(sessionsArg.where).toBeDefined();
      expect(mockDb.query.cinemas.findMany).toHaveBeenCalled();
    });

    it("should return an empty result without querying movies when the city/cinema filter matches no rooms", async () => {
      // ARRANGE
      mockDb.query.cinemas.findMany.mockResolvedValue([]);

      // ACT
      const result = await service.listMovies({ city: "Nowhere" });

      // ASSERT
      expect(result).toEqual([]);
      expect(mockDb.query.movies.findMany).not.toHaveBeenCalled();
    });

    it("should apply a same-day range condition when a date filter is given", async () => {
      // ARRANGE
      mockDb.query.movies.findMany.mockResolvedValue([movieWithSession]);

      // ACT
      const result = await service.listMovies({ date: "2026-01-01" });

      // ASSERT — no city/cinemaId given, so cinemas.findMany is never consulted
      expect(mockDb.query.cinemas.findMany).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("should resolve a cinemaId filter without needing a city", async () => {
      // ARRANGE
      mockDb.query.cinemas.findMany.mockResolvedValue([{ id: "cinema-1", rooms: [{ id: "room-1" }] }]);
      mockDb.query.movies.findMany.mockResolvedValue([movieWithSession]);

      // ACT
      const result = await service.listMovies({ cinemaId: "cinema-1" });

      // ASSERT
      expect(mockDb.query.cinemas.findMany).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("should keep movies with no sessions when no filter is applied (unchanged default behavior)", async () => {
      // ARRANGE
      mockDb.query.movies.findMany.mockResolvedValue([{ ...movieWithSession, sessions: [] }]);

      // ACT
      const result = await service.listMovies();

      // ASSERT
      expect(result).toHaveLength(1);
      expect(mockDb.query.cinemas.findMany).not.toHaveBeenCalled();
    });
  });
});
