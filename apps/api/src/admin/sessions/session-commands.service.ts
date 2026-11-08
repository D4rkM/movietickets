import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module";
import { isForeignKeyViolation } from "../../db/pg-errors";
import * as schema from "../../db/schema";
import { Db, Tx } from "../shared/db.types";
import { lockMovie, lockRoom, lockSession } from "../shared/row-locks";
import { AdminSession } from "./admin-session.types";
import { CreateSessionDto, UpdateSessionDto } from "./dto/session.dto";
import { SessionActivityService } from "./session-activity.service";
import { hasStarted, sessionDeleteBlockReason, sessionEditBlockReason } from "./session-edit-policy";
import { SessionQueriesService } from "./session-queries.service";
import { findOverlappingSession, ScheduleCandidate } from "./session-schedule";

const SESSION_NOT_FOUND = "Sessão não encontrada";
const MOVIE_NOT_FOUND = "Filme não encontrado";
const ROOM_NOT_FOUND = "Sala não encontrada";
const SESSION_HAS_BOOKINGS = "Sessão tem reservas e não pode ser excluída";

@Injectable()
export class SessionCommandsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly queries: SessionQueriesService,
    private readonly activity: SessionActivityService,
  ) {}

  /**
   * The room row is locked (FOR UPDATE) before reading its sessions, so two
   * overlapping creations in the same room run one after the other and the
   * second one sees the first and gets a 409.
   */
  async create(dto: CreateSessionDto): Promise<AdminSession> {
    const sessionId = await this.db.transaction(async (tx) => {
      const durationMinutes = await this.lockScheduleTarget(tx, dto.movieId, dto.roomId);
      const startsAt = new Date(dto.startsAt);
      await this.assertFitsInRoom(tx, { roomId: dto.roomId, startsAt, durationMinutes });

      const [session] = await tx
        .insert(schema.sessions)
        .values({ movieId: dto.movieId, roomId: dto.roomId, startsAt, priceCents: dto.priceCents })
        .returning({ id: schema.sessions.id });
      return session.id;
    });
    return this.queries.getById(sessionId);
  }

  async update(id: string, dto: UpdateSessionDto): Promise<AdminSession> {
    await this.db.transaction(async (tx) => {
      const session = await lockSession(tx, id);
      if (!session) {
        throw new NotFoundException(SESSION_NOT_FOUND);
      }
      if (hasStarted(session.startsAt)) {
        throw new ConflictException("Sessão já iniciada não pode ser alterada");
      }

      const target = {
        movieId: dto.movieId ?? session.movieId,
        roomId: dto.roomId ?? session.roomId,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : session.startsAt,
        priceCents: dto.priceCents ?? session.priceCents,
      };
      // Only real changes count: a form re-sending the stored values isn't an edit.
      const changes = {
        schedule:
          target.movieId !== session.movieId ||
          target.roomId !== session.roomId ||
          target.startsAt.getTime() !== session.startsAt.getTime(),
        price: target.priceCents !== session.priceCents,
      };
      if (!changes.schedule && !changes.price) {
        return;
      }

      const durationMinutes = changes.schedule
        ? await this.lockScheduleTarget(tx, target.movieId, target.roomId)
        : undefined;

      const blockReason = sessionEditBlockReason(changes, await this.activity.read(tx, id));
      if (blockReason) {
        throw new ConflictException(blockReason);
      }

      if (durationMinutes !== undefined) {
        await this.assertFitsInRoom(tx, {
          roomId: target.roomId,
          startsAt: target.startsAt,
          durationMinutes,
          excludeSessionId: id,
        });
      }

      await tx.update(schema.sessions).set(target).where(eq(schema.sessions.id, id));
    });
    return this.queries.getById(id);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const session = await lockSession(tx, id);
        if (!session) {
          throw new NotFoundException(SESSION_NOT_FOUND);
        }
        if (hasStarted(session.startsAt)) {
          throw new ConflictException("Sessão já iniciada não pode ser excluída");
        }
        const blockReason = sessionDeleteBlockReason(await this.activity.read(tx, id));
        if (blockReason) {
          throw new ConflictException(blockReason);
        }
        await tx.delete(schema.sessions).where(eq(schema.sessions.id, id));
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new ConflictException(SESSION_HAS_BOOKINGS);
      throw err;
    }
  }

  /**
   * Locks the movie (FOR SHARE, so its duration can't change mid-check) and
   * then the room (FOR UPDATE), 404 when either is missing. Returns the
   * movie's duration.
   */
  private async lockScheduleTarget(tx: Tx, movieId: string, roomId: string): Promise<number> {
    const durationMinutes = await lockMovie(tx, movieId, "share");
    if (durationMinutes === undefined) {
      throw new NotFoundException(MOVIE_NOT_FOUND);
    }
    if (!(await lockRoom(tx, roomId))) {
      throw new NotFoundException(ROOM_NOT_FOUND);
    }
    return durationMinutes;
  }

  private async assertFitsInRoom(tx: Tx, candidate: ScheduleCandidate): Promise<void> {
    if (await findOverlappingSession(tx, candidate)) {
      throw new ConflictException("Horário se sobrepõe a outra sessão na mesma sala");
    }
  }
}
