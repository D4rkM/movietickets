import { BusinessMetrics } from "../../src/telemetry/business-metrics";

export type MockBusinessMetrics = { [K in keyof BusinessMetrics]: jest.Mock };

/** Unit-test double for BusinessMetrics: one `jest.fn()` per public method. */
export function createMockBusinessMetrics(): MockBusinessMetrics {
  const methods = Object.getOwnPropertyNames(BusinessMetrics.prototype).filter(
    (name) => name !== "constructor" && name !== "addPositive",
  ) as (keyof BusinessMetrics)[];
  return Object.fromEntries(methods.map((name) => [name, jest.fn()])) as MockBusinessMetrics;
}
