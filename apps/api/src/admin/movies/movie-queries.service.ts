import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { Db } from "../shared/db.types";
import { AdminMovie, toAdminMovie } from "./admin-movie.types";

@Injectable()
export class MovieQueriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(): Promise<AdminMovie[]> {
    const movies = await this.db.query.movies.findMany({ orderBy: asc(schema.movies.title) });
    return movies.map(toAdminMovie);
  }

  async getById(id: string): Promise<AdminMovie> {
    const movie = await this.db.query.movies.findFirst({ where: eq(schema.movies.id, id) });
    if (!movie) {
      throw new NotFoundException("Filme não encontrado");
    }
    return toAdminMovie(movie);
  }
}
