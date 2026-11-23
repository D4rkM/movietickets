import { describe, expect, it } from "vitest";
import { formatCentsBRL } from "./money";

describe("formatCentsBRL", () => {
  it.each([
    [5000, "R$ 50,00"],
    [2550, "R$ 25,50"],
    [5, "R$ 0,05"],
    [0, "R$ 0,00"],
  ])("should format %i cents as %s", (cents, expected) => {
    // ARRANGE
    const input = cents;

    // ACT
    const formatted = formatCentsBRL(input);

    // ASSERT
    expect(formatted).toBe(expected);
  });
});
