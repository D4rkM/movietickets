import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { PASSWORD, submitLogin } from "./visitor";

export const ADMIN_EMAIL = "admin@movietickets.dev";

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await submitLogin(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/movies$/);
  await expect(page.getByRole("button", { name: /Admin/i })).toBeVisible();
  await expect(page.getByText( PASSWORD )).not.toBeVisible();
}

export async function openAdminFromProfileMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Admin/i }).click();
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

export async function createMovieFromAdminForm(
  page: Page,
  movie: { title: string; durationMinutes: number; synopsis?: string },
): Promise<void> {
  await page.getByRole("link", { name: "Filmes" }).first().click();
  await page.getByRole("link", { name: "Novo filme" }).click();
  await page.getByLabel("Título").fill(movie.title);
  if (movie.synopsis) {
    await page.getByLabel("Sinopse").fill(movie.synopsis);
  }
  await page.getByLabel("Duração (min)").fill(String(movie.durationMinutes));
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/admin\/movies$/);
  await expect(page.getByRole("cell", { name: movie.title })).toBeVisible();
}

export async function createRoomFromAdminForm(
  page: Page,
  room: { name: string; rows: number; seatsPerRow: number },
): Promise<void> {
  await page.getByRole("link", { name: "Salas" }).first().click();
  await page.getByRole("link", { name: "Nova sala" }).click();
  await page.getByLabel("Nome").fill(room.name);
  await page.getByLabel("Fileiras").fill(String(room.rows));
  await page.getByLabel("Assentos por fileira").fill(String(room.seatsPerRow));
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/admin\/rooms$/);
  await expect(page.getByRole("cell", { name: room.name })).toBeVisible();
}

export async function createSessionFromAdminForm(
  page: Page,
  session: { movieTitle: string; roomLabelSubstring: string; startsAtLocal: string; priceReais: string },
): Promise<void> {
  await page.getByRole("link", { name: "Sessões" }).first().click();
  await page.getByRole("link", { name: "Nova sessão" }).click();
  await page.getByLabel("Filme").selectOption({ label: session.movieTitle });
  const roomSelect = page.getByLabel("Sala");
  const roomOptionValue = await roomSelect
    .locator("option", { hasText: session.roomLabelSubstring })
    .getAttribute("value");
  await roomSelect.selectOption(roomOptionValue!);
  await page.getByLabel(/Início \(horário de São Paulo\)/i).fill(session.startsAtLocal);
  await page.getByLabel(/Preço \(R\$\)/i).fill(session.priceReais);
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page).toHaveURL(/\/admin\/sessions$/);
}
