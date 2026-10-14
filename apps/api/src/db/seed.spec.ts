import { randomCatalogSessionDate, randomCinemaAddress, randomFutureSessionDate } from "./seed";

describe("randomFutureSessionDate", () => {
  it("should return a date at least 3 days ahead", () => {
    // ARRANGE
    const before = Date.now();

    // ACT
    const result = randomFutureSessionDate();

    // ASSERT
    const minMs = before + 3 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(minMs);
  });

  it("should return a date at most 7 days ahead", () => {
    // ACT
    const result = randomFutureSessionDate();
    const after = Date.now();

    // ASSERT
    const maxMs = after + 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeLessThanOrEqual(maxMs);
  });

  it("should vary across calls instead of always returning the same offset", () => {
    // ARRANGE
    const samples = Array.from({ length: 20 }, () => randomFutureSessionDate().getTime());

    // ACT
    const uniqueValues = new Set(samples);

    // ASSERT
    expect(uniqueValues.size).toBeGreaterThan(1);
  });
});

describe("randomCatalogSessionDate", () => {
  it("should return a date at least 1 hour ahead", () => {
    // ARRANGE
    const before = Date.now();

    // ACT
    const result = randomCatalogSessionDate();

    // ASSERT
    const minMs = before + 60 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(minMs);
  });

  it("should return a date at most 7 days ahead", () => {
    // ACT
    const result = randomCatalogSessionDate();
    const after = Date.now();

    // ASSERT
    const maxMs = after + 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeLessThanOrEqual(maxMs);
  });

  it("should vary across calls instead of always returning the same offset", () => {
    // ARRANGE
    const samples = Array.from({ length: 20 }, () => randomCatalogSessionDate().getTime());

    // ACT
    const uniqueValues = new Set(samples);

    // ASSERT
    expect(uniqueValues.size).toBeGreaterThan(1);
  });
});

describe("randomCinemaAddress", () => {
  it("should return a non-empty street address and city", () => {
    // ACT
    const { address, city } = randomCinemaAddress();

    // ASSERT
    expect(address.length).toBeGreaterThan(0);
    expect(city.length).toBeGreaterThan(0);
  });

  it("should vary across calls instead of always returning the same address", () => {
    // ARRANGE
    const samples = Array.from({ length: 20 }, () => randomCinemaAddress().address);

    // ACT
    const uniqueValues = new Set(samples);

    // ASSERT
    expect(uniqueValues.size).toBeGreaterThan(1);
  });
});
