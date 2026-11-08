import { ConflictException, NotFoundException } from "@nestjs/common";
import { Db } from "../shared/db.types";
import { createFakeDb, FakeDb, postgresError } from "../../../test/helpers/fake-db";
import { RoomCommandsService } from "./room-commands.service";
import { RoomQueriesService } from "./room-queries.service";

const adminRoom = { id: "room-1", name: "Sala 1", rows: 3, seatsPerRow: 4, cinemaId: "cinema-1", cinemaName: "Cine" };
const storedRoom = { id: "room-1", cinemaId: "cinema-1", name: "Sala 1", rows: 3, seatsPerRow: 4, createdAt: new Date() };

describe("Room services", () => {
  let db: FakeDb;
  let queries: RoomQueriesService;
  let commands: RoomCommandsService;

  beforeEach(() => {
    db = createFakeDb();
    queries = new RoomQueriesService(db as unknown as Db);
    commands = new RoomCommandsService(db as unknown as Db, queries);
  });

  const insertedSeats = () => db.calls.filter((call) => call.method === "values").at(-1)?.args[0] as unknown[];

  describe("RoomQueriesService", () => {
    it("should list rooms", async () => {
      // ARRANGE
      db.queue([adminRoom]);

      // ACT
      const result = await queries.list("cinema-1");

      // ASSERT
      expect(result).toEqual([adminRoom]);
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
    it("should throw NotFoundException when the cinema does not exist", async () => {
      // ARRANGE
      db.query.cinemas.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = commands.create({ cinemaId: "missing", name: "Sala", rows: 2, seatsPerRow: 2 });

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("should insert the room and rows × seatsPerRow seats", async () => {
      // ARRANGE
      db.query.cinemas.findFirst.mockResolvedValue({ id: "cinema-1" });
      db.queue([{ id: "room-1" }], [], [adminRoom]);

      // ACT
      const result = await commands.create({ cinemaId: "cinema-1", name: "Sala 1", rows: 3, seatsPerRow: 4 });

      // ASSERT
      expect(insertedSeats()).toHaveLength(12);
      expect(insertedSeats()[0]).toEqual({ roomId: "room-1", rowLabel: "A", seatNumber: 1 });
      expect(result).toEqual(adminRoom);
    });

    it("should turn a duplicate name into ConflictException", async () => {
      // ARRANGE
      db.query.cinemas.findFirst.mockResolvedValue({ id: "cinema-1" });
      db.queue(postgresError("23505"));

      // ACT
      const result = commands.create({ cinemaId: "cinema-1", name: "Sala 1", rows: 3, seatsPerRow: 4 });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });
  });

  describe("update", () => {
    it("should throw NotFoundException when the room does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = commands.update("missing", { name: "X" });

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should refuse a layout change when the room has sessions", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [storedRoom], [{ id: "session-1" }]);

      // ACT
      const result = commands.update("room-1", { rows: 4 });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("should regenerate the seats on a layout change without sessions", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [storedRoom], [], [], [], [], [{ ...adminRoom, rows: 2, seatsPerRow: 2 }]);

      // ACT
      const result = await commands.update("room-1", { rows: 2, seatsPerRow: 2 });

      // ASSERT
      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(insertedSeats()).toHaveLength(4);
      expect(result.rows).toBe(2);
    });

    it("should rename without touching seats or checking sessions", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [storedRoom], [], [{ ...adminRoom, name: "Sala Nova" }]);

      // ACT
      const result = await commands.update("room-1", { name: "Sala Nova", rows: 3 });

      // ASSERT
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(result.name).toBe("Sala Nova");
    });

    it("should turn a duplicate name into ConflictException", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [storedRoom], postgresError("23505"));

      // ACT
      const result = commands.update("room-1", { name: "Sala 2" });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });
  });

  describe("delete", () => {
    it("should throw NotFoundException when the room does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = commands.delete("missing");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should refuse to delete a room with sessions", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [{ id: "session-1" }]);

      // ACT
      const result = commands.delete("room-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("should delete the seats and then the room", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [], [], []);

      // ACT
      await commands.delete("room-1");

      // ASSERT
      expect(db.delete).toHaveBeenCalledTimes(2);
    });

    it("should turn a foreign key violation into ConflictException", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [], postgresError("23503"));

      // ACT
      const result = commands.delete("room-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });

    it("should rethrow unexpected errors", async () => {
      // ARRANGE
      db.queue([{ id: "room-1" }], [], new Error("connection lost"));

      // ACT
      const result = commands.delete("room-1");

      // ASSERT
      await expect(result).rejects.toThrow("connection lost");
    });
  });
});
