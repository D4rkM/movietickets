import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { Db } from "../shared/db.types";
import { AdminCinema, toAdminCinema } from "./admin-cinema.types";

@Injectable()
export class CinemaQueriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(): Promise<AdminCinema[]> {
    const cinemas = await this.db.query.cinemas.findMany({ orderBy: asc(schema.cinemas.name) });
    return cinemas.map(toAdminCinema);
  }

  async getById(id: string): Promise<AdminCinema> {
    const cinema = await this.db.query.cinemas.findFirst({ where: eq(schema.cinemas.id, id) });
    if (!cinema) {
      throw new NotFoundException("Cinema não encontrado");
    }
    return toAdminCinema(cinema);
  }
}
