import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// The one case only a real browser validates: two independent clients watching
// the same session's seat map, one holding a seat, the other seeing it update
// live over the WebSocket — no refresh, no refetch.
test("should show a seat held by one user as blocked for another user watching the same session", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  async function registerAndLogin(page: Page, email: string) {
    await page.goto("/register");
    await page.getByLabel("Nome").fill("Realtime Test");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("password123");
    await page.getByLabel("Confirmar senha").fill("password123");
    await page.getByRole("button", { name: "Criar conta" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha").fill("password123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/movies$/);
  }

  const stamp = Date.now();
  await registerAndLogin(pageA, `ws-a-${stamp}@test.com`);
  await registerAndLogin(pageB, `ws-b-${stamp}@test.com`);

  // Both end up watching the same session's seat map
  await pageA.locator('a[href^="/sessions/"]').first().click();
  await expect(pageA).toHaveURL(/\/sessions\/.+\/seats$/);
  await pageB.goto(pageA.url());
  await expect(pageB).toHaveURL(pageA.url());

  // Tab A holds the first free seat
  const freeSeatA = pageA.locator('button[title$="— Disponível"]').first();
  const seatLabel = (await freeSeatA.getAttribute("title"))!.split(" — ")[0];
  await freeSeatA.click();
  await expect(pageA.getByTitle(`${seatLabel} — Selecionado`)).toBeVisible();

  // Tab B, which never clicked anything, sees it go blocked on its own
  await expect(pageB.getByTitle(`${seatLabel} — Bloqueado`)).toBeVisible();

  await contextA.close();
  await contextB.close();
});
