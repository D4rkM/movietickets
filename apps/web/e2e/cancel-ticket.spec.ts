import { expect, test } from "@playwright/test";

// Real cancellation against the real backend — not mocked, unlike the
// Vitest/RTL coverage for this component.
test("should cancel a confirmed ticket and free its seat back up", async ({ page }) => {
  // GIVEN a user who just completed a (mocked-payment) booking
  const email = `cancel-ticket-${Date.now()}@test.com`;
  await page.goto("/register");
  await page.getByLabel("Nome").fill("Cancel Ticket Test");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill("password123");
  await page.getByLabel("Confirmar senha").fill("password123");
  await page.getByRole("button", { name: "Criar conta" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("password123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/movies$/);

  await page.locator('a[href^="/sessions/"]').first().click();
  await expect(page).toHaveURL(/\/sessions\/.+\/seats$/);
  const seatsUrl = page.url();

  const freeSeat = page.locator('button[title$="— Disponível"]').first();
  const seatLabel = (await freeSeat.getAttribute("title"))!.split(" — ")[0];
  await freeSeat.click();
  await expect(page.getByTitle(`${seatLabel} — Selecionado`)).toBeVisible();

  await page.getByRole("button", { name: /^Pagar/ }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByRole("button", { name: /^Pagar$/ }).click();
  await expect(page.getByText("Ingresso confirmado!")).toBeVisible();

  // WHEN the user cancels it from "Meus ingressos"
  await page.getByRole("link", { name: "Voltar ao catálogo" }).click();
  await expect(page).toHaveURL(/\/movies$/);
  await page.getByRole("button", { name: "Cancel Ticket Test" }).click();
  await page.getByRole("link", { name: "Ver ingressos" }).click();
  await expect(page).toHaveURL(/\/tickets$/);

  await page.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Sim, cancelar" }).click();

  // THEN the ticket is gone from the list
  await expect(page.getByText("Você ainda não tem ingressos confirmados.")).toBeVisible();

  // AND the seat is free again on the seat map
  await page.goto(seatsUrl);
  await expect(page.getByTitle(`${seatLabel} — Disponível`)).toBeVisible();
});
