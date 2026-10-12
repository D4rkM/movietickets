import { defineConfig, devices } from "@playwright/test";

// Assumes a real backend is already up (docker compose up postgres valkey +
// `pnpm --filter api start:dev`), same convention as the back's test:integration —
// this config only starts the web dev server itself, not its dependencies.
export default defineConfig({
  testDir: "./e2e",
  // Every spec shares the one seeded session/room from `pnpm --filter api db:seed`
  // (no dedicated-fixture-per-test setup, unlike the back's e2e specs) — each
  // picks "the first free seat" independently, so running files in parallel lets
  // two of them grab the same seat at once and makes one lose the real race.
  // The suite is still small enough that running serially costs little.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // Vite's dev server compiles each route's modules on first visit, so the very
  // first navigation in a test run can be noticeably slower than a warm one.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
