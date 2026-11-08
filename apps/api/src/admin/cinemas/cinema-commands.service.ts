import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import * as schema from "../../db/schema";
import { Db } from "../shared/db.types";
import { definedFields } from "../shared/defined-fields";
import { AdminCinema, toAdminCinema } from "./admin-cinema.types";
import { CinemaQueriesService } from "./cinema-queries.service";
import { CreateCinemaDto, UpdateCinemaDto } from "./dto/cinema.dto";

@Injectable()
export class CinemaCommandsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queries: CinemaQueriesService,
  ) {}

  async create(dto: CreateCinemaDto): Promise<AdminCinema> {
    const [cinema] = await this.db
      .insert(schema.cinemas)
      .values({ name: dto.name, address: dto.address, city: dto.city })
      .returning();
    return toAdminCinema(cinema);
  }

  async update(id: string, dto: UpdateCinemaDto): Promise<AdminCinema> {
    const changes = definedFields(dto);
    if (Object.keys(changes).length === 0) {
      return this.queries.getById(id);
    }
    const [cinema] = await this.db.update(schema.cinemas).set(changes).where(eq(schema.cinemas.id, id)).returning();
    if (!cinema) {
      // Same 404 the query side gives for an unknown id.
      return this.queries.getById(id);
    }
    return toAdminCinema(cinema);
  }
}
