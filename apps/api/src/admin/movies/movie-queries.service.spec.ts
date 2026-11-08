import { NotFoundException } from "@nestjs/common";
import { Db } from "../shared/db.types";
import { createFakeDb, FakeDb } from "../../../test/helpers/fake-db";
import { MovieQueriesService } from "./movie-queries.service";

const movie = {
  id: "movie-1",
  title: "Filme",
  synopsis: "Sinopse",
  durationMinutes: 100,
  posterUrl: "https://example.com/p.jpg",
  rating: "12",
  createdAt: new Date(),
};

describe("MovieQueriesService", () => {
  let db: FakeDb;
  let service: MovieQueriesService;

  beforeEach(() => {
    db = createFakeDb();
    service = new MovieQueriesService(db as unknown as Db);
  });

  it("should list movies without internal columns", async () => {
    // ARRANGE
    db.query.movies.findMany.mockResolvedValue([movie]);

    // ACT
    const result = await service.list();

    // ASSERT
    expect(result).toEqual([
      { id: "movie-1", title: "Filme", synopsis: "Sinopse", durationMinutes: 100, posterUrl: movie.posterUrl, rating: "12" },
    ]);
  });

  it("should return one movie by id", async () => {
    // ARRANGE
    db.query.movies.findFirst.mockResolvedValue(movie);

    // ACT
    const result = await service.getById("movie-1");

    // ASSERT
    expect(result.id).toBe("movie-1");
  });

  it("should throw NotFoundException for an unknown id", async () => {
    // ARRANGE
    db.query.movies.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.getById("missing");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });
});
