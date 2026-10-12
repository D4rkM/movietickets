import { expect, test } from "@playwright/test";

// Real filter requests against the real backend — not mocked, unlike the
// Vitest/RTL coverage for this component.
test("should filter the catalog against the real backend", async ({ page }) => {
  // GIVEN a logged-in user looking at the catalog (seeded session, city "Testópolis")
  const email = `catalog-filter-${Date.now()}@test.com`;
  await page.goto("/register");
  await page.getByLabel("Nome").fill("Catalog Filter Test");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("password123");
  await page.getByLabel("Confirmar senha").fill("password123");
  await page.getByRole("button", { name: "Criar conta" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("password123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/movies$/);
  await expect(page.getByText("Vingadores Ultimato")).toBeVisible();

  // WHEN the user filters by the city the seeded session is actually in
  await page.getByLabel("Cidade").selectOption("Testópolis");

  // THEN the movie is still there — this round-tripped through the real API
  await expect(page.getByText("Vingadores Ultimato")).toBeVisible();

  // WHEN the user then filters by a date with no sessions at all (seeded
  // sessions always sit 3-7 days out, so "today" never matches)
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("Data").fill(today);

  // THEN the catalog really did go back to the server and came back empty
  await expect(page.getByText("Nenhum filme em cartaz no momento.")).toBeVisible();

  // WHEN the user clears the filters
  await page.getByRole("button", { name: "Limpar filtros" }).click();

  // THEN the movie is back
  await expect(page.getByText("Vingadores Ultimato")).toBeVisible();
});
