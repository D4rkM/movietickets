import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { CatalogService } from "./catalog.service";

describe("CatalogService", () => {
  const mockDb = {
    query: { movies: { findMany: jest.fn() } },
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
});
