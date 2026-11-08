import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PASSWORD = "password123";

/** Creates an account through the UI without logging in (register and login are separate steps). */
export async function registerAccount(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Nome").fill(name);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirmar senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export async function openCatalogAsVisitor(page: Page): Promise<void> {
  await page.goto("/movies");
  await expect(page.getByRole("heading", { name: "Em cartaz" })).toBeVisible();
}

/** Opens the first session's seat map from the catalog and returns its path (`/sessions/<id>/seats`). */
export async function openFirstSessionSeats(page: Page): Promise<string> {
  await page.locator('a[href^="/sessions/"]').first().click();
  await expect(page).toHaveURL(/\/sessions\/.+\/seats$/);
  await expect(page.locator('button[title$="— Disponível"]').first()).toBeVisible();
  return new URL(page.url()).pathname;
}

/** Holds the first free seat and returns its label (e.g. "C7"). */
export async function holdFirstFreeSeat(page: Page): Promise<string> {
  const freeSeat = page.locator('button[title$="— Disponível"]').first();
  const seatLabel = (await freeSeat.getAttribute("title"))!.split(" — ")[0];
  await freeSeat.click();
  await expect(page.getByTitle(`${seatLabel} — Selecionado`)).toBeVisible();
  return seatLabel;
}

export async function clickContinue(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Continuar/ }).click();
}

export async function submitLogin(page: Page, email: string): Promise<void> {
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

export function storedGuestToken(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("movietickets:guestToken"));
}
