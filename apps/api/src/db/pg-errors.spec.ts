import { isForeignKeyViolation, isUniqueViolation } from "./pg-errors";

function wrapped(code: string): Error {
  return new Error("Failed query", { cause: { code } });
}

describe("pg-errors", () => {
  it.each([
    ["the error itself", { code: "23505" }, true],
    ["the error's cause (drizzle wrapping)", wrapped("23505"), true],
    ["a different code", wrapped("23503"), false],
    ["a non-object", "boom", false],
  ])("should detect a unique violation on %s", (_label, err, expected) => {
    // ARRANGE / ACT
    const result = isUniqueViolation(err);

    // ASSERT
    expect(result).toBe(expected);
  });

  it.each([
    ["the error itself", { code: "23503" }, true],
    ["the error's cause (drizzle wrapping)", wrapped("23503"), true],
    ["a different code", wrapped("23505"), false],
    ["null", null, false],
  ])("should detect a foreign key violation on %s", (_label, err, expected) => {
    // ARRANGE / ACT
    const result = isForeignKeyViolation(err);

    // ASSERT
    expect(result).toBe(expected);
  });
});
