import { ConflictException, NotFoundException } from "@nestjs/common";
import { Db } from "../shared/db.types";
import { createFakeDb, FakeDb, postgresError } from "../../../test/helpers/fake-db";
import { MovieCommandsService } from "./movie-commands.service";

const storedMovie = {
  id: "movie-1",
  title: "Filme",
  synopsis: null,
  durationMinutes: 120,
  posterUrl: null,
  rating: null,
  createdAt: new Date(),
};
const futureStart = new Date("2030-01-10T19:00:00.000Z");

describe("MovieCommandsService", () => {
  let db: FakeDb;
  let service: MovieCommandsService;

  beforeEach(() => {
    db = createFakeDb();
    service = new MovieCommandsService(db as unknown as Db);
  });

  describe("create", () => {
    it("should store omitted optional fields as null and return the admin view", async () => {
      // ARRANGE
      db.queue([storedMovie]);

      // ACT
      const result = await service.create({ title: "Filme", durationMinutes: 120 });

      // ASSERT
      const values = db.calls.find((call) => call.method === "values")?.args[0];
      expect(values).toEqual({ title: "Filme", synopsis: null, durationMinutes: 120, posterUrl: null, rating: null });
      expect(result).toEqual({
        id: "movie-1",
        title: "Filme",
        synopsis: null,
        durationMinutes: 120,
        posterUrl: null,
        rating: null,
      });
    });
  });

  describe("update", () => {
    it("should throw NotFoundException when the movie does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = service.update("missing", { title: "X" });

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException when the new duration makes a future session overlap another", async () => {
      // ARRANGE
      db.queue(
        [{ durationMinutes: 120 }], // movie lock
        [{ id: "s1", roomId: "r1", startsAt: futureStart }], // future sessions of the movie
        [{ id: "r1" }], // room lock
        [{ id: "s2", movieId: "other", startsAt: new Date("2030-01-10T21:00:00.000Z"), durationMinutes: 90 }],
      );

      // ACT
      const result = service.update("movie-1", { durationMinutes: 121 });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should save the new duration when no future session overlaps", async () => {
      // ARRANGE
      db.queue(
        [{ durationMinutes: 120 }],
        [{ id: "s1", roomId: "r1", startsAt: futureStart }],
        [{ id: "r1" }],
        [{ id: "s2", movieId: "other", startsAt: new Date("2030-01-10T22:00:00.000Z"), durationMinutes: 90 }],
        [{ ...storedMovie, durationMinutes: 180 }],
      );

      // ACT
      const result = await service.update("movie-1", { durationMinutes: 180 });

      // ASSERT
      expect(result.durationMinutes).toBe(180);
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toEqual({ durationMinutes: 180 });
    });

    it("should skip the overlap check when the duration does not change", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [{ ...storedMovie, title: "Novo" }]);

      // ACT
      const result = await service.update("movie-1", { title: "Novo", durationMinutes: 120 });

      // ASSERT
      expect(result.title).toBe("Novo");
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it("should return the stored movie without updating when the patch is empty", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [storedMovie]);

      // ACT
      const result = await service.update("movie-1", {});

      // ASSERT
      expect(result.id).toBe("movie-1");
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("should throw NotFoundException when the movie does not exist", async () => {
      // ARRANGE
      db.queue([]);

      // ACT
      const result = service.delete("missing");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException when the movie has any session", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [{ id: "s1" }]);

      // ACT
      const result = service.delete("movie-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it("should delete a movie without sessions", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], []);

      // ACT
      await service.delete("movie-1");

      // ASSERT
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it("should turn a foreign key violation (session created meanwhile) into ConflictException", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [], postgresError("23503"));

      // ACT
      const result = service.delete("movie-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });

    it("should rethrow unexpected errors", async () => {
      // ARRANGE
      db.queue([{ durationMinutes: 120 }], [], new Error("connection lost"));

      // ACT
      const result = service.delete("movie-1");

      // ASSERT
      await expect(result).rejects.toThrow("connection lost");
    });
  });
});
