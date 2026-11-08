import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import { isForeignKeyViolation, isUniqueViolation } from "../../db/pg-errors";
import * as schema from "../../db/schema";
import { Db, Tx } from "../shared/db.types";
import { definedFields } from "../shared/defined-fields";
import { lockRoom } from "../shared/row-locks";
import { AdminRoom } from "./admin-room.types";
import { CreateRoomDto, UpdateRoomDto } from "./dto/room.dto";
import { RoomQueriesService } from "./room-queries.service";
import { generateSeatLayout } from "./seat-layout";

const DUPLICATE_ROOM_NAME = "Já existe uma sala com esse nome neste cinema";
const ROOM_NOT_FOUND = "Sala não encontrada";
const ROOM_HAS_SESSIONS_DELETE = "Sala tem sessões cadastradas e não pode ser excluída";
const ROOM_HAS_SESSIONS_LAYOUT = "Sala tem sessões cadastradas; o layout de assentos não pode mudar";

@Injectable()
export class RoomCommandsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queries: RoomQueriesService,
  ) {}

  /** Creates the room and its `rows × seatsPerRow` seats in one transaction. */
  async create(dto: CreateRoomDto): Promise<AdminRoom> {
    const roomId = await this.translateDuplicateName(() =>
      this.db.transaction(async (tx) => {
        const cinema = await tx.query.cinemas.findFirst({ where: eq(schema.cinemas.id, dto.cinemaId) });
        if (!cinema) {
          throw new NotFoundException("Cinema não encontrado");
        }
        const [room] = await tx
          .insert(schema.rooms)
          .values({ cinemaId: dto.cinemaId, name: dto.name, rows: dto.rows, seatsPerRow: dto.seatsPerRow })
          .returning({ id: schema.rooms.id });
        await this.insertSeats(tx, room.id, dto.rows, dto.seatsPerRow);
        return room.id;
      }),
    );
    return this.queries.getById(roomId);
  }

  /**
   * Renaming is always allowed. Changing the layout regenerates every seat,
   * which is only safe while no session (past or future) points at the room:
   * seats are referenced by bookings and by seat-hold keys.
   */
  async update(id: string, dto: UpdateRoomDto): Promise<AdminRoom> {
    await this.translateDuplicateName(() =>
      this.db.transaction(async (tx) => {
        if (!(await lockRoom(tx, id))) {
          throw new NotFoundException(ROOM_NOT_FOUND);
        }
        const [room] = await tx.select().from(schema.rooms).where(eq(schema.rooms.id, id));
        const rows = dto.rows ?? room.rows;
        const seatsPerRow = dto.seatsPerRow ?? room.seatsPerRow;

        if (rows !== room.rows || seatsPerRow !== room.seatsPerRow) {
          if (await this.hasSessions(tx, id)) {
            throw new ConflictException(ROOM_HAS_SESSIONS_LAYOUT);
          }
          await tx.delete(schema.seats).where(eq(schema.seats.roomId, id));
          await this.insertSeats(tx, id, rows, seatsPerRow);
        }

        const changes = definedFields(dto);
        if (Object.keys(changes).length > 0) {
          await tx.update(schema.rooms).set(changes).where(eq(schema.rooms.id, id));
        }
      }),
    );
    return this.queries.getById(id);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        if (!(await lockRoom(tx, id))) {
          throw new NotFoundException(ROOM_NOT_FOUND);
        }
        if (await this.hasSessions(tx, id)) {
          throw new ConflictException(ROOM_HAS_SESSIONS_DELETE);
        }
        await tx.delete(schema.seats).where(eq(schema.seats.roomId, id));
        await tx.delete(schema.rooms).where(eq(schema.rooms.id, id));
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new ConflictException(ROOM_HAS_SESSIONS_DELETE);
      throw err;
    }
  }

  private async hasSessions(tx: Tx, roomId: string): Promise<boolean> {
    const [session] = await tx
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.roomId, roomId))
      .limit(1);
    return Boolean(session);
  }

  private async insertSeats(tx: Tx, roomId: string, rows: number, seatsPerRow: number): Promise<void> {
    const layout = generateSeatLayout(rows, seatsPerRow);
    await tx.insert(schema.seats).values(layout.map((seat) => ({ roomId, ...seat })));
  }

  /** `unique(cinema_id, name)` on rooms: a duplicate name is a 409, not a 500. */
  private async translateDuplicateName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(DUPLICATE_ROOM_NAME);
      throw err;
    }
  }
}
