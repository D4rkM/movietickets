import { expect, test } from "@playwright/test";
import {
  approvePaymentsThroughRealConfirm,
  payWithStubbedCard,
  STUB_CARD_TOKEN,
  stubMercadoPagoSdk,
} from "./helpers/mercadopago";

// Real cancellation against the real backend — not mocked, unlike the
// Vitest/RTL coverage for this component.
test("should cancel a confirmed ticket and free its seat back up", async ({ page }) => {
  // Paying for real means tokenizing a card in Mercado Pago's PCI iframes and
  // charging it through their API, neither of which e2e can drive (and CI only
  // has a placeholder access token). Instead, MercadoPago.js is replaced by a
  // stub with the same Core Methods surface, and the payment request is
  // intercepted: the real backend still confirms the booking through its own
  // confirm route (standing in for the approved charge), so the ticket being
  // cancelled below is a genuinely confirmed booking in the database.
  await stubMercadoPagoSdk(page);
  const paymentPayloads = await approvePaymentsThroughRealConfirm(page);

  // GIVEN a user who just paid for a booking (payment stubbed, see above)
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

  await page.getByRole("button", { name: /^Continuar/ }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByRole("button", { name: "Continuar para pagamento" }).click();

  await payWithStubbedCard(page, { name: "CANCEL TICKET TEST", cpf: "529.982.247-25", email });
  // Generous timeout: the intercepted route makes a real round-trip to the
  // backend's confirm endpoint (which also sends the confirmation e-mail).
  await expect(page.getByRole("heading", { name: "Pagamento aprovado!" })).toBeVisible({ timeout: 20_000 });
  expect(paymentPayloads).toHaveLength(1);
  expect(paymentPayloads[0]).toMatchObject({
    token: STUB_CARD_TOKEN,
    paymentMethodId: "visa",
    installments: 1,
    payer: { email, identification: { type: "CPF", number: "52998224725" } },
  });

  // WHEN the user cancels it from "Meus ingressos"
  await page.getByRole("link", { name: "Ver meus ingressos" }).click();
  await expect(page).toHaveURL(/\/tickets$/);

  await page.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Sim, cancelar" }).click();

  // THEN the ticket is gone from the list
  await expect(page.getByText("Você ainda não tem ingressos confirmados.")).toBeVisible();

  // AND the seat is free again on the seat map
  await page.goto(seatsUrl);
  await expect(page.getByTitle(`${seatLabel} — Disponível`)).toBeVisible();
});
