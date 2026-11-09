import { describe, expect, it } from "vitest";
import { cleanCpf, isValidCpf, isValidEmail } from "./validation";

describe("cleanCpf", () => {
  it("should strip non-digit characters from a formatted CPF", () => {
    // ARRANGE
    const formatted = "123.456.789-09";

    // ACT
    const digits = cleanCpf(formatted);

    // ASSERT
    expect(digits).toBe("12345678909");
  });
});

describe("isValidCpf", () => {
  it.each([
    "52998224725",
    "529.982.247-25",
    "11144477735",
    "12345678909",
  ])("should return true for valid CPF %s", (cpf) => {
    // ARRANGE
    const input = cpf;

    // ACT
    const valid = isValidCpf(input);

    // ASSERT
    expect(valid).toBe(true);
  });

  it.each([
    { reason: "wrong first check digit", cpf: "52998224715" },
    { reason: "wrong second check digit", cpf: "52998224726" },
    { reason: "too short", cpf: "5299822472" },
    { reason: "too long", cpf: "529982247250" },
    { reason: "empty string", cpf: "" },
    { reason: "all zeros", cpf: "00000000000" },
    { reason: "all ones", cpf: "111.111.111-11" },
    { reason: "all nines", cpf: "99999999999" },
  ])("should return false when CPF has $reason ($cpf)", ({ cpf }) => {
    // ARRANGE
    const input = cpf;

    // ACT
    const valid = isValidCpf(input);

    // ASSERT
    expect(valid).toBe(false);
  });
});

describe("isValidEmail", () => {
  it.each([
    { email: "buyer@example.com", expected: true },
    { email: "  buyer@example.com  ", expected: true },
    { email: "", expected: false },
    { email: "missing-at.com", expected: false },
    { email: "missing-domain@", expected: false },
    { email: "has spaces@example.com", expected: false },
  ])("should return $expected for email '$email'", ({ email, expected }) => {
    // ARRANGE
    const input = email;

    // ACT
    const valid = isValidEmail(input);

    // ASSERT
    expect(valid).toBe(expected);
  });
});
