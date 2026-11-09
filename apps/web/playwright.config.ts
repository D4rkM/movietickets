import { defineConfig, devices } from "@playwright/test";

// Defaults match CI and `pnpm dev`. E2E_WEB_PORT / E2E_API_URL let the suite run
// beside a local stack that already holds 5173/3000 (e.g. `make up-full`), so
// it never reuses or hits those containers by accident.
const webPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const webUrl = `http://localhost:${webPort}`;
const apiUrl = process.env.E2E_API_URL;

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
    baseURL: webUrl,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --port ${webPort} --strictPort`,
    url: webUrl,
    env: apiUrl ? { VITE_API_URL: apiUrl } : {},
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
