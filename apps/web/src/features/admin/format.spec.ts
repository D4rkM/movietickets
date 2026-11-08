import { describe, expect, it } from "vitest";
import {
  centsToReaisInput,
  formatPriceReais,
  formatSaoPauloDateTime,
  isoToSaoPauloDateTimeLocal,
  reaisToCents,
  saoPauloDateTimeLocalToIso,
} from "./format";

describe("America/Sao_Paulo datetime conversions (AC25)", () => {
  it.each([
    ["2026-12-20T19:00", "2026-12-20T22:00:00.000Z"],
    ["2026-12-20T00:00", "2026-12-20T03:00:00.000Z"],
    ["2026-12-20T22:30", "2026-12-21T01:30:00.000Z"],
    ["2026-06-15T14:15:30", "2026-06-15T17:15:30.000Z"],
  ])(
    "should convert Sao Paulo datetime-local %s to UTC ISO %s",
    (dateTimeLocal, expectedIso) => {
      // ARRANGE — input wall-clock in America/Sao_Paulo

      // ACT
      const result = saoPauloDateTimeLocalToIso(dateTimeLocal);

      // ASSERT
      expect(result).toBe(expectedIso);
    },
  );

  it.each([
    ["2026-12-20T22:00:00.000Z", "2026-12-20T19:00"],
    ["2026-12-20T03:00:00.000Z", "2026-12-20T00:00"],
    ["2026-12-21T01:30:00.000Z", "2026-12-20T22:30"],
    ["2026-06-15T17:15:00.000Z", "2026-06-15T14:15"],
  ])(
    "should convert UTC ISO %s to Sao Paulo datetime-local %s",
    (iso, expectedDateTimeLocal) => {
      // ARRANGE — UTC ISO timestamp

      // ACT
      const result = isoToSaoPauloDateTimeLocal(iso);

      // ASSERT
      expect(result).toBe(expectedDateTimeLocal);
    },
  );

  it("should format UTC ISO timestamps into DD/MM/YYYY HH:mm in America/Sao_Paulo", () => {
    // ARRANGE
    const iso = "2026-12-20T22:00:00.000Z";

    // ACT
    const formatted = formatSaoPauloDateTime(iso);

    // ASSERT
    expect(formatted).toBe("20/12/2026 19:00");
  });

  it("should return empty string for invalid datetime strings", () => {
    // ARRANGE / ACT / ASSERT
    expect(saoPauloDateTimeLocalToIso("not-a-date")).toBe("");
    expect(isoToSaoPauloDateTimeLocal("not-a-date")).toBe("");
    expect(formatSaoPauloDateTime("not-a-date")).toBe("");
  });
});

describe("price conversions between reais and cents", () => {
  it.each([
    ["35", 3500],
    ["35.50", 3550],
    ["35,50", 3550],
    ["29.9", 2990],
    ["0.01", 1],
    ["0", 0],
    [42.75, 4275],
  ])("should convert %s reais into %i cents", (input, expectedCents) => {
    // ARRANGE — price input in reais

    // ACT
    const cents = reaisToCents(input);

    // ASSERT
    expect(cents).toBe(expectedCents);
  });

  it.each(["", "abc", "12.345", "10..00"])(
    "should return NaN for invalid price input %s",
    (invalidInput) => {
      // ARRANGE / ACT
      const cents = reaisToCents(invalidInput);

      // ASSERT
      expect(Number.isNaN(cents)).toBe(true);
    },
  );

  it("should format cents back to decimal input and display strings", () => {
    // ARRANGE
    const priceCents = 3050;

    // ACT & ASSERT
    expect(centsToReaisInput(priceCents)).toBe("30.50");
    expect(formatPriceReais(priceCents)).toBe("R$ 30.50");
  });
});
