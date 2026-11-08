import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateMovieDto, UpdateMovieDto } from "./movie.dto";

async function errorFields(dtoClass: new () => object, payload: object): Promise<string[]> {
  const errors = await validate(plainToInstance(dtoClass, payload));
  return errors.map((error) => error.property);
}

const validMovie = { title: "Filme", durationMinutes: 120 };

describe("Movie DTOs", () => {
  it.each(["L", "10", "12", "14", "16", "18", undefined])("should accept rating %p", async (rating) => {
    // ARRANGE
    const payload = { ...validMovie, rating };

    // ACT
    const fields = await errorFields(CreateMovieDto, payload);

    // ASSERT
    expect(fields).toEqual([]);
  });

  it.each(["15", "livre", ""])("should reject rating %p", async (rating) => {
    // ARRANGE
    const payload = { ...validMovie, rating };

    // ACT
    const fields = await errorFields(CreateMovieDto, payload);

    // ASSERT
    expect(fields).toEqual(["rating"]);
  });

  it.each([
    ["an empty title", { title: "" }, "title"],
    ["a blank title", { title: "   " }, "title"],
    ["a 201-char title", { title: "x".repeat(201) }, "title"],
    ["duration 0", { durationMinutes: 0 }, "durationMinutes"],
    ["duration 601", { durationMinutes: 601 }, "durationMinutes"],
    ["a fractional duration", { durationMinutes: 90.5 }, "durationMinutes"],
    ["an ftp poster URL", { posterUrl: "ftp://example.com/p.jpg" }, "posterUrl"],
    ["a poster URL without protocol", { posterUrl: "example.com/p.jpg" }, "posterUrl"],
  ])("should reject a new movie with %s", async (_label, override, field) => {
    // ARRANGE
    const payload = { ...validMovie, ...override };

    // ACT
    const fields = await errorFields(CreateMovieDto, payload);

    // ASSERT
    expect(fields).toEqual([field]);
  });

  it.each([
    ["an http poster", { posterUrl: "http://example.com/p.jpg" }],
    ["an https poster", { posterUrl: "https://example.com/p.jpg" }],
    ["duration 1", { durationMinutes: 1 }],
    ["duration 600", { durationMinutes: 600 }],
  ])("should accept a new movie with %s", async (_label, override) => {
    // ARRANGE
    const payload = { ...validMovie, ...override };

    // ACT
    const fields = await errorFields(CreateMovieDto, payload);

    // ASSERT
    expect(fields).toEqual([]);
  });

  it.each([
    ["an empty patch", {}, []],
    ["only a new title", { title: "Outro" }, []],
    ["optional fields cleared with null", { synopsis: null, posterUrl: null, rating: null }, []],
    ["a null title", { title: null }, ["title"]],
    ["a null duration", { durationMinutes: null }, ["durationMinutes"]],
    ["an invalid rating", { rating: "15" }, ["rating"]],
  ])("should validate an update with %s", async (_label, payload, expected) => {
    // ARRANGE / ACT
    const fields = await errorFields(UpdateMovieDto, payload);

    // ASSERT
    expect(fields).toEqual(expected);
  });
});
