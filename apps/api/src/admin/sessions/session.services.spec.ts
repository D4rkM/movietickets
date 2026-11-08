import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Redis } from "ioredis";
import { Db } from "../shared/db.types";
import { createFakeDb, FakeDb, postgresError } from "../../../test/helpers/fake-db";
import { SessionActivityService } from "./session-activity.service";
import { SessionCommandsService } from "./session-commands.service";
import { SessionActivity } from "./session-edit-policy";
import { SessionQueriesService } from "./session-queries.service";

const futureStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const storedSession = { id: "session-1", movieId: "movie-1", roomId: "room-1", startsAt: futureStart, priceCents: 3000 };
const idle: SessionActivity = {
  hasPendingBooking: false,
  hasConfirmedBooking: false,
  hasAnyBooking: false,
  hasActiveHold: false,
};
const sessionRow = {
  id: "session-1",
  startsAt: new Date("2030-01-10T19:00:00.000Z"),
  priceCents: 3000,
  movie: { id: "movie-1", title: "Filme", durationMinutes: 135 },
  room: { id: "room-1", name: "Sala 1" },
  cinema: { id: "cinema-1", name: "Cine" },
};

describe("Session services", () => {
  let db: FakeDb;
  let queries: SessionQueriesService;
  const mockActivity = { read: jest.fn() };
  let commands: SessionCommandsService;

  beforeEach(() => {
    jest.clearAllMocks();
    db = createFakeDb();
    queries = new SessionQueriesService(db as unknown as Db);
    commands = new SessionCommandsService(db as unknown as Db, queries, mockActivity as unknown as SessionActivityService);
    mockActivity.read.mockResolvedValue(idle);
  });

  describe("SessionQueriesService", () => {
    it("should return times in ISO UTC with the end computed from the movie duration", async () => {
      // ARRANGE
      db.queue([sessionRow]);

      // ACT
      const result = await queries.list();

      // ASSERT
      expect(result).toEqual([
        expect.objectContaining({ startsAt: "2030-01-10T19:00:00.000Z", endsAt: "2030-01-10T21:15:00.000Z" }),
      ]);
    });

    it("should not filter by time when past sessions are included", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      await queries.list(true);

      // ASSERT
      expect(db.calls.find((call) => call.method === "where")?.args[0]).toBeUndefined();
    });

    it("should throw NotFoundException for an unknown id", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = queries.getById("missing");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });
  });

  describe("create", () => {
    const dto = { movieId: "movie-1", roomId: "room-1", startsAt: "2030-01-10T16:00:00-03:00", priceCents: 3000 };

    it("should throw NotFoundException when the movie does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = commands.create(dto);

      // ASSERT
      await expect(result).rejects.toThrow("Filme não encontrado");
    });

    it("should throw NotFoundException when the room does not exist", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], []);

      // ACT
      const result = commands.create(dto);

      // ASSERT
      await expect(result).rejects.toThrow("Sala não encontrada");
    });

    it("should throw ConflictException when the room already has an overlapping session", async () => {
      // ARRANGE
      db.queue(
        [{ durationMinutes: 120 }],
        [{ id: "room-1" }],
        [{ id: "other", movieId: "movie-2", startsAt: new Date("2030-01-10T20:00:00.000Z"), durationMinutes: 90 }],
      );

      // ACT
      const result = commands.create(dto);

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("should lock the room before reading its sessions and store startsAt as the same instant", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [{ id: "room-1" }], [], [{ id: "session-1" }], [sessionRow]);

      // ACT
      const result = await commands.create(dto);

      // ASSERT
      const lockModes = db.calls.filter((call) => call.method === "for").map((call) => call.args[0]);
      expect(lockModes).toEqual(["share", "update"]);
      const values = db.calls.find((call) => call.method === "values")?.args[0] as { startsAt: Date };
      expect(values.startsAt.toISOString()).toBe("2030-01-10T19:00:00.000Z");
      expect(result.id).toBe("session-1");
    });
  });

  describe("update", () => {
    it("should throw NotFoundException when the session does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = commands.update("missing", { priceCents: 1 });

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should refuse to edit a session that already started", async () => {
      // ARRANGE
      db.queue([{ ...storedSession, startsAt: new Date(Date.now() - 60_000) }]);

      // ACT
      const result = commands.update("session-1", { priceCents: 1 });

      // ASSERT
      await expect(result).rejects.toThrow("Sessão já iniciada não pode ser alterada");
    });

    it("should do nothing when the sent values equal the stored ones", async () => {
      // ARRANGE
      db.queue([storedSession], [sessionRow]);

      // ACT
      await commands.update("session-1", { movieId: "movie-1", startsAt: futureStart.toISOString(), priceCents: 3000 });

      // ASSERT
      expect(mockActivity.read).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should refuse a price change while someone is mid-checkout", async () => {
      // ARRANGE
      db.queue([storedSession]);
      mockActivity.read.mockResolvedValue({ ...idle, hasActiveHold: true });

      // ACT
      const result = commands.update("session-1", { priceCents: 4000 });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should change only the price without locking movie or room", async () => {
      // ARRANGE
      db.queue([storedSession], [], [sessionRow]);
      mockActivity.read.mockResolvedValue({ ...idle, hasConfirmedBooking: true, hasAnyBooking: true });

      // ACT
      await commands.update("session-1", { priceCents: 4000 });

      // ASSERT
      expect(db.calls.filter((call) => call.method === "for")).toHaveLength(1);
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toEqual(
        expect.objectContaining({ priceCents: 4000, startsAt: futureStart }),
      );
    });

    it("should refuse a new time that overlaps another session in the room", async () => {
      // ARRANGE
      const newStart = new Date(futureStart.getTime() + 60 * 60 * 1000);
      db.queue(
        [storedSession],
        [{ durationMinutes: 120 }],
        [{ id: "room-1" }],
        [{ id: "other", movieId: "movie-2", startsAt: new Date(newStart.getTime() + 30 * 60 * 1000), durationMinutes: 90 }],
      );

      // ACT
      const result = commands.update("session-1", { startsAt: newStart.toISOString() });

      // ASSERT
      await expect(result).rejects.toThrow("Horário se sobrepõe a outra sessão na mesma sala");
    });

    it("should move the session to another room when it fits", async () => {
      // ARRANGE
      db.queue([storedSession], [{ durationMinutes: 120 }], [{ id: "room-2" }], [], [], [sessionRow]);

      // ACT
      await commands.update("session-1", { roomId: "room-2" });

      // ASSERT
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toEqual(
        expect.objectContaining({ roomId: "room-2" }),
      );
    });
  });

  describe("delete", () => {
    it("should throw NotFoundException when the session does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = commands.delete("missing");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should refuse to delete a session that already started", async () => {
      // ARRANGE
      db.queue([{ ...storedSession, startsAt: new Date(Date.now() - 60_000) }]);

      // ACT
      const result = commands.delete("session-1");

      // ASSERT
      await expect(result).rejects.toThrow("Sessão já iniciada não pode ser excluída");
    });

    it("should refuse to delete a session with any booking", async () => {
      // ARRANGE
      db.queue([storedSession]);
      mockActivity.read.mockResolvedValue({ ...idle, hasAnyBooking: true });

      // ACT
      const result = commands.delete("session-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("should delete a session without activity", async () => {
      // ARRANGE
      db.queue([storedSession], []);

      // ACT
      await commands.delete("session-1");

      // ASSERT
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it("should turn a foreign key violation (booking created meanwhile) into ConflictException", async () => {
      // ARRANGE
      db.queue([storedSession], postgresError("23503"));

      // ACT
      const result = commands.delete("session-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });

    it("should rethrow unexpected errors", async () => {
      // ARRANGE
      db.queue([storedSession], new Error("connection lost"));

      // ACT
      const result = commands.delete("session-1");

      // ASSERT
      await expect(result).rejects.toThrow("connection lost");
    });
  });

  describe("SessionActivityService", () => {
    const mockValkey = { scan: jest.fn() };
    const activityService = new SessionActivityService(mockValkey as unknown as Redis);

    it.each([
      ["no bookings and no holds", [], [], idle],
      [
        "a pending and a cancelled booking",
        [{ status: "pending" }, { status: "cancelled" }],
        [],
        { ...idle, hasPendingBooking: true, hasAnyBooking: true },
      ],
      [
        "a confirmed booking",
        [{ status: "confirmed" }],
        [],
        { ...idle, hasConfirmedBooking: true, hasAnyBooking: true },
      ],
      ["an active hold", [], ["seat-hold:session-1:seat-1"], { ...idle, hasActiveHold: true }],
    ])("should report %s", async (_label, bookings, holdKeys, expected) => {
      // ARRANGE
      db.queue(bookings);
      mockValkey.scan.mockResolvedValue(["0", holdKeys]);

      // ACT
      const result = await activityService.read(db as never, "session-1");

      // ASSERT
      expect(result).toEqual(expected);
      expect(mockValkey.scan).toHaveBeenCalledWith("0", "MATCH", "seat-hold:session-1:*", "COUNT", 100);
    });
  });
});
