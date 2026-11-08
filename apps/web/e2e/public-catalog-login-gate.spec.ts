import { expect, test } from "@playwright/test";
import {
  clickContinue,
  holdFirstFreeSeat,
  openCatalogAsVisitor,
  openFirstSessionSeats,
  registerAccount,
  storedGuestToken,
  submitLogin,
} from "./helpers/visitor";

// Spec: docs/flows/public-catalog-login-gate/spec.md. Runs against the real
// API, Postgres and Valkey (see playwright.config.ts).

test("AC1: visitante sem login acessa o catálogo e vê filmes com sessões, sem ir pro login", async ({ page }) => {
  // GIVEN um visitante que nunca fez login

  // WHEN ele abre o catálogo
  await openCatalogAsVisitor(page);

  // THEN continua em /movies e vê filmes com sessões pra escolher
  await expect(page).toHaveURL(/\/movies$/);
  await expect(page.locator('a[href^="/sessions/"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar" })).toBeVisible();
});

test("AC5: visitante que clica em Continuar vai pro login com returnTo da página de assentos", async ({ page }) => {
  // GIVEN um visitante que segurou um assento na página de assentos
  await openCatalogAsVisitor(page);
  const seatsPath = await openFirstSessionSeats(page);
  await holdFirstFreeSeat(page);

  // WHEN ele clica em Continuar
  await clickContinue(page);

  // THEN vai pro login com returnTo apontando de volta pros assentos
  await expect(page).toHaveURL(`/login?returnTo=${seatsPath}`);
  expect(await storedGuestToken(page)).not.toBeNull();
});

test("AC6: visitante seleciona, continua, loga e vê os mesmos assentos como seus", async ({ page }) => {
  // GIVEN um visitante com conta criada que segurou um assento antes de logar
  const email = `guest-transfer-${Date.now()}@test.com`;
  await registerAccount(page, "Guest Transfer", email);
  await openCatalogAsVisitor(page);
  const seatsPath = await openFirstSessionSeats(page);
  const seatLabel = await holdFirstFreeSeat(page);

  // WHEN ele clica em Continuar e faz login
  await clickContinue(page);
  await expect(page).toHaveURL(`/login?returnTo=${seatsPath}`);
  await submitLogin(page, email);

  // THEN volta pra página de assentos com o mesmo assento selecionado, agora como usuário
  await expect(page).toHaveURL(seatsPath);
  await expect(page.getByTitle(`${seatLabel} — Selecionado`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar (1 assento)" })).toBeEnabled();
  expect(await storedGuestToken(page)).toBeNull();

  // WHEN ele recarrega a página
  await page.reload();

  // THEN o assento continua selecionado, porque o hold no servidor agora é do usuário
  await expect(page.getByTitle(`${seatLabel} — Selecionado`)).toBeVisible();
});
