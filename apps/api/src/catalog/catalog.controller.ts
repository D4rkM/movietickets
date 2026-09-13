import { Controller, Get } from "@nestjs/common";
import { CatalogService } from "./catalog.service";

@Controller("movies")
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  listMovies() {
    return this.catalogService.listMovies();
  }
}
