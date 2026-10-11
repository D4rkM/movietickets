import { expect, test } from "@playwright/test";

// Setup-only smoke test: proves Playwright is wired to a real browser hitting
// the real dev server and a real backend. It doesn't cover any actual feature
// — those land per-feature in the `[Front]` cards that depend on this one.
test("should register, log in, and reach the catalog", async ({ page }) => {
  // GIVEN a brand new account
  const email = `playwright-smoke-${Date.now()}@test.com`;

  // WHEN the user registers and then logs in with it
  await page.goto("/register");
  await page.getByLabel("Nome").fill("Playwright Smoke");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("password123");
  await page.getByLabel("Confirmar senha").fill("password123");
  await page.getByRole("button", { name: "Criar conta" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("password123");
  await page.getByRole("button", { name: "Entrar" }).click();

  // THEN it reaches the catalog
  await expect(page).toHaveURL(/\/movies$/);
  await expect(page.getByRole("heading", { name: "Em cartaz" })).toBeVisible();
});
