import { expect, test } from "@playwright/test";
import {
  createMovieFromAdminForm,
  createRoomFromAdminForm,
  createSessionFromAdminForm,
  loginAsAdmin,
  openAdminFromProfileMenu,
} from "./helpers/admin";

// Spec: docs/flows/admin-panel/spec.md (AC23).

test("AC23: admin loga, cria filme, sala e sessão pelos formulários e vê a sessão em /movies", async ({
  page,
}) => {
  // GIVEN um administrador autenticado que acessa o painel /admin
  const suffix = Date.now();
  const movieTitle = `Filme Admin ${suffix}`;
  const roomName = `Sala Admin ${suffix}`;

  await loginAsAdmin(page);
  await openAdminFromProfileMenu(page);

  // WHEN ele cadastra um filme, uma sala e uma sessão pelos formulários do painel
  await createMovieFromAdminForm(page, {
    title: movieTitle,
    durationMinutes: 120,
    synopsis: "Criado via teste e2e do painel admin",
  });
  await createRoomFromAdminForm(page, {
    name: roomName,
    rows: 5,
    seatsPerRow: 8,
  });
  await createSessionFromAdminForm(page, {
    movieTitle,
    roomLabelSubstring: roomName,
    startsAtLocal: "2027-12-20T19:00",
    priceReais: "42.00",
  });

  // AND navega de volta para o catálogo /movies
  await page.getByRole("link", { name: "Catálogo" }).click();

  // THEN vê o filme e a sessão recém-criada listados em /movies
  await expect(page).toHaveURL(/\/movies$/);
  await expect(page.getByRole("heading", { name: movieTitle })).toBeVisible();
  await expect(page.getByText(new RegExp(`${roomName} · R\\$ 42\\.00`))).toBeVisible();
});
