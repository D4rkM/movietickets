import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { ListMoviesQueryDto } from "./dto/list-movies-query.dto";

describe("CatalogController", () => {
  const mockCatalogService = { listMovies: jest.fn() };
  let controller: CatalogController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CatalogController(mockCatalogService as unknown as CatalogService);
  });

  it("should delegate to CatalogService with the parsed query filters", async () => {
    // ARRANGE
    const query: ListMoviesQueryDto = { city: "Recife" };
    mockCatalogService.listMovies.mockResolvedValue([]);

    // ACT
    const result = await controller.listMovies(query);

    // ASSERT
    expect(mockCatalogService.listMovies).toHaveBeenCalledWith(query);
    expect(result).toEqual([]);
  });
});
