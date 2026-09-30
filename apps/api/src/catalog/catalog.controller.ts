import { Controller, Get, Query } from "@nestjs/common";
import { CatalogService } from "./catalog.service";
import { ListMoviesQueryDto } from "./dto/list-movies-query.dto";

@Controller("movies")
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  listMovies(@Query() query: ListMoviesQueryDto) {
    return this.catalogService.listMovies(query);
  }
}
