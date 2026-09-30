import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ListMoviesQueryDto } from "./list-movies-query.dto";

describe("ListMoviesQueryDto", () => {
  it("should be valid with no filters at all", async () => {
    // ARRANGE
    const dto = plainToInstance(ListMoviesQueryDto, {});

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });

  it("should be valid with city, cinemaId and date all set", async () => {
    // ARRANGE
    const dto = plainToInstance(ListMoviesQueryDto, {
      city: "Recife",
      cinemaId: "3d0cbaf7-3a51-8155-b653-ffa28e2361a4",
      date: "2026-01-01",
    });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });

  it("should be invalid when cinemaId isn't a UUID", async () => {
    // ARRANGE
    const dto = plainToInstance(ListMoviesQueryDto, { cinemaId: "not-a-uuid" });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors.some((error) => error.property === "cinemaId")).toBe(true);
  });

  it("should be invalid when date isn't a valid ISO date string", async () => {
    // ARRANGE
    const dto = plainToInstance(ListMoviesQueryDto, { date: "not-a-date" });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors.some((error) => error.property === "date")).toBe(true);
  });
});
