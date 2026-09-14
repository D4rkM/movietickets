import { describe, expect, it } from "vitest";
import { isValidEmail } from "./validation";

describe("isValidEmail", () => {
  it("should accept an email with a proper domain and TLD", () => {
    // ARRANGE
    const email = "user@example.com";

    // ACT
    const result = isValidEmail(email);

    // ASSERT
    expect(result).toBe(true);
  });

  it("should reject an email without an @", () => {
    // ARRANGE
    const email = "userexample.com";

    // ACT
    const result = isValidEmail(email);

    // ASSERT
    expect(result).toBe(false);
  });

  it("should reject an email without a domain TLD", () => {
    // ARRANGE
    const email = "user@example";

    // ACT
    const result = isValidEmail(email);

    // ASSERT
    expect(result).toBe(false);
  });

  it("should reject an email with spaces", () => {
    // ARRANGE
    const email = "user @example.com";

    // ACT
    const result = isValidEmail(email);

    // ASSERT
    expect(result).toBe(false);
  });

  it("should reject an empty string", () => {
    // ARRANGE
    const email = "";

    // ACT
    const result = isValidEmail(email);

    // ASSERT
    expect(result).toBe(false);
  });
});
