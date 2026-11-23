import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { E2E_API_URL } from "./api";
import { payWithStubbedCard } from "./mercadopago";
import { holdFirstFreeSeat, registerAccount, submitLogin } from "./visitor";

/** Same deadline the backend enforces: cancellation allowed until 2 hours before the session. */
const CANCELLATION_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** Extra room so the session can't cross the deadline while the test is running. */
const DEADLINE_SAFETY_MARGIN_MS = 30 * 60 * 1000;

export interface CatalogSessionInfo {
  id: string;
  startsAt: string;
  priceCents: number;
  movieTitle: string;
}

/** Registers a fresh customer and logs in through the UI; returns the e-mail. */
export async function registerAndLogin(page: Page, emailPrefix: string): Promise<string> {
  const email = `${emailPrefix}-${Date.now()}@test.com`;
  await registerAccount(page, "Refund Test", email);
  await submitLogin(page, email);
  await expect(page).toHaveURL(/\/movies$/);
  return email;
}

/**
 * Picks a catalog session that is still cancellable: the seed spreads catalog
 * sessions from 1 hour to 7 days out, and one within 2 hours would get 409
 * `CANCELLATION_DEADLINE_PASSED`. Read from the public catalog endpoint, so the
 * backend and its seed stay untouched.
 */
export async function findCancellableSession(page: Page): Promise<CatalogSessionInfo> {
  const response = await page.request.get(`${E2E_API_URL}/movies`);
  expect(response.ok(), `GET /movies returned ${response.status()}`).toBe(true);
  const movies = (await response.json()) as Array<{
    title: string;
    sessions: Array<Omit<CatalogSessionInfo, "movieTitle">>;
  }>;
  const earliestStart = Date.now() + CANCELLATION_DEADLINE_MS + DEADLINE_SAFETY_MARGIN_MS;
  const session = movies
    .flatMap((movie) => movie.sessions.map((candidate) => ({ ...candidate, movieTitle: movie.title })))
    .find((candidate) => new Date(candidate.startsAt).getTime() > earliestStart);
  expect(session, "no catalog session starts more than 2h30 from now").toBeTruthy();
  return session!;
}

/** Opens the given session's seat map from the catalog; returns its path. */
export async function openSessionSeatsFromCatalog(page: Page, sessionId: string): Promise<string> {
  await page.goto("/movies");
  await page.locator(`a[href="/sessions/${sessionId}/seats"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}/seats$`));
  await expect(page.locator('button[title$="— Disponível"]').first()).toBeVisible();
  return new URL(page.url()).pathname;
}

/**
 * Holds the first free seat and pays for it with the stubbed card (requires
 * `stubMercadoPagoSdk` + `approvePaymentsThroughRealConfirm` on the page).
 * Returns the seat label.
 */
export async function buyFirstFreeSeat(page: Page, email: string): Promise<string> {
  const seatLabel = await holdFirstFreeSeat(page);
  await page.getByRole("button", { name: /^Continuar/ }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByRole("button", { name: "Continuar para pagamento" }).click();
  await payWithStubbedCard(page, { name: "REFUND TEST", cpf: "529.982.247-25", email });
  // Generous timeout: the intercepted route makes a real round-trip to the
  // backend's confirm endpoint (which also sends the confirmation e-mail).
  await expect(page.getByRole("heading", { name: "Pagamento aprovado!" })).toBeVisible({ timeout: 20_000 });
  return seatLabel;
}

export async function openMyTickets(page: Page): Promise<void> {
  await page.goto("/tickets");
  await expect(page.getByRole("heading", { name: "Meus ingressos" })).toBeVisible();
}

/** The ticket card (`<li>`) of the given movie in "Meus ingressos". */
export function ticketCard(page: Page, movieTitle: string): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: movieTitle, exact: true }) });
}

/** Clicks "Cancelar" on the ticket and returns the confirmation dialog. */
export async function openCancelDialog(page: Page, movieTitle: string): Promise<Locator> {
  await ticketCard(page, movieTitle).getByRole("button", { name: "Cancelar" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function confirmCancellation(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Sim, cancelar" }).click();
}

/** Formats like the page does (browser locale/timezone), so expectations match the rendered text. */
export function formatDateTimeInPage(page: Page, iso: string): Promise<string> {
  return page.evaluate(
    (value) => new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
    iso,
  );
}

export function formatCentsBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

export function cancellationDeadlineOf(startsAt: string): string {
  return new Date(new Date(startsAt).getTime() - CANCELLATION_DEADLINE_MS).toISOString();
}
