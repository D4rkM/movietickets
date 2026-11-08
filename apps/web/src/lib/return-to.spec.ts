import { describe, expect, it } from "vitest";
import { DEFAULT_RETURN_TO, resolveReturnTo } from "./return-to";

describe("resolveReturnTo (AC9)", () => {
  it.each([
    ["/sessions/abc/seats", "/sessions/abc/seats"],
    ["/movies", "/movies"],
    ["/sessions/abc/seats?from=catalog", "/sessions/abc/seats?from=catalog"],
  ])("AC9: should accept the internal path %s", (value, expected) => {
    // ARRANGE — value from the table

    // ACT
    const result = resolveReturnTo(value);

    // ASSERT
    expect(result).toBe(expected);
  });

  it.each([
    ["protocol-relative //", "//evil.example"],
    ["leading backslash", "\\evil.example"],
    ["slash-backslash", "/\\evil.example"],
    ["encoded slash %2F", "/%2Fevil.example"],
    ["encoded slash lowercase %2f", "/%2fevil.example"],
    ["encoded backslash %5C", "/%5Cevil.example"],
    ["absolute https URL", "https://evil.example/sessions/1/seats"],
    ["javascript: URL", "javascript:alert(1)"],
    ["relative path without leading slash", "sessions/1/seats"],
    ["empty string", ""],
  ])("AC9: should fall back to /movies for %s", (_label, value) => {
    // ARRANGE — value from the table

    // ACT
    const result = resolveReturnTo(value);

    // ASSERT
    expect(result).toBe(DEFAULT_RETURN_TO);
  });

  it.each([null, undefined])("AC9: should fall back to /movies when returnTo is %s", (value) => {
    // ARRANGE — value from the table

    // ACT
    const result = resolveReturnTo(value);

    // ASSERT
    expect(result).toBe("/movies");
  });
});
