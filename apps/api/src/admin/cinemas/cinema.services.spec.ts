import { NotFoundException } from "@nestjs/common";
import { Db } from "../shared/db.types";
import { createFakeDb, FakeDb } from "../../../test/helpers/fake-db";
import { CinemaCommandsService } from "./cinema-commands.service";
import { CinemaQueriesService } from "./cinema-queries.service";

const cinema = { id: "cinema-1", name: "Cine", address: "Rua A, 1", city: "Santos", createdAt: new Date() };
const adminCinema = { id: "cinema-1", name: "Cine", address: "Rua A, 1", city: "Santos" };

describe("Cinema services", () => {
  let db: FakeDb;
  let queries: CinemaQueriesService;
  let commands: CinemaCommandsService;

  beforeEach(() => {
    db = createFakeDb();
    queries = new CinemaQueriesService(db as unknown as Db);
    commands = new CinemaCommandsService(db as unknown as Db, queries);
  });

  describe("CinemaQueriesService", () => {
    it("should list cinemas", async () => {
      // ARRANGE
      db.query.cinemas.findMany.mockResolvedValue([cinema]);

      // ACT
      const result = await queries.list();

      // ASSERT
      expect(result).toEqual([adminCinema]);
    });

    it("should throw NotFoundException for an unknown id", async () => {
      // ARRANGE
      db.query.cinemas.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = queries.getById("missing");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });
  });

  describe("CinemaCommandsService", () => {
    it("should create a cinema", async () => {
      // ARRANGE
      db.queue([cinema]);

      // ACT
      const result = await commands.create({ name: "Cine", address: "Rua A, 1", city: "Santos" });

      // ASSERT
      expect(result).toEqual(adminCinema);
    });

    it("should update only the fields sent", async () => {
      // ARRANGE
      db.queue([{ ...cinema, city: "Campinas" }]);

      // ACT
      const result = await commands.update("cinema-1", { city: "Campinas" });

      // ASSERT
      expect(db.calls.find((call) => call.method === "set")?.args[0]).toEqual({ city: "Campinas" });
      expect(result.city).toBe("Campinas");
    });

    it("should return the stored cinema when the patch is empty", async () => {
      // ARRANGE
      db.query.cinemas.findFirst.mockResolvedValue(cinema);

      // ACT
      const result = await commands.update("cinema-1", {});

      // ASSERT
      expect(result).toEqual(adminCinema);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when updating an unknown cinema", async () => {
      // ARRANGE
      db.queue([]);
      db.query.cinemas.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = commands.update("missing", { name: "X" });

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });
  });
});
