import { expect, test } from "@playwright/test";
import { approvePaymentsThroughRealConfirm, STUB_CARD_TOKEN, stubMercadoPagoSdk } from "./helpers/mercadopago";
import {
  buyFirstFreeSeat,
  cancellationDeadlineOf,
  confirmCancellation,
  findCancellableSession,
  formatCentsBRL,
  formatDateTimeInPage,
  openCancelDialog,
  openMyTickets,
  openSessionSeatsFromCatalog,
  registerAndLogin,
  ticketCard,
} from "./helpers/tickets";

// Spec: docs/flows/refund/spec.md (AC27, AC28).
//
// Real cancellation against the real backend — not mocked, unlike the
// Vitest/RTL coverage for this page. Paying for real means tokenizing a card in
// Mercado Pago's PCI iframes and charging it through their API, neither of which
// e2e can drive (and CI only has a placeholder access token). Instead,
// MercadoPago.js is replaced by a stub and the payment request is intercepted:
// the real backend confirms the booking through its own confirm route, so the
// ticket cancelled below is a genuinely confirmed booking in the database —
// one without an approved payment, which the backend cancels without a refund
// (`refund: null`). The refund outcomes themselves are covered in refund.spec.ts.
test("AC27: deve mostrar valor e prazo no diálogo, cancelar o ingresso, mantê-lo na lista e liberar o assento", async ({
  page,
}) => {
  await stubMercadoPagoSdk(page);
  const paymentPayloads = await approvePaymentsThroughRealConfirm(page);

  // GIVEN a customer who just paid for a seat in a session more than 2 hours away
  const email = await registerAndLogin(page, "cancel-ticket");
  const session = await findCancellableSession(page);
  const seatsPath = await openSessionSeatsFromCatalog(page, session.id);
  const seatLabel = await buyFirstFreeSeat(page, email);
  expect(paymentPayloads).toHaveLength(1);
  expect(paymentPayloads[0]).toMatchObject({
    token: STUB_CARD_TOKEN,
    paymentMethodId: "visa",
    installments: 1,
    payer: { email, identification: { type: "CPF", number: "52998224725" } },
  });

  // WHEN they open the cancel dialog in "Meus ingressos"
  await page.getByRole("link", { name: "Ver meus ingressos" }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  const dialog = await openCancelDialog(page, session.movieTitle);

  // THEN the dialog shows the full-refund amount and the cancellation deadline from the backend
  await expect(dialog).toContainText(
    `Ao cancelar, o valor de ${formatCentsBRL(session.priceCents)} será estornado integralmente no cartão usado na compra.`,
  );
  const deadline = await formatDateTimeInPage(page, cancellationDeadlineOf(session.startsAt));
  await expect(dialog).toContainText(`Cancelamento permitido até ${deadline} (2 horas antes da sessão).`);

  // WHEN they confirm the cancellation
  await confirmCancellation(dialog);

  // THEN the ticket stays listed as cancelled, with no refund badge (nothing was charged)
  await expect(dialog).toBeHidden();
  const card = ticketCard(page, session.movieTitle);
  await expect(card.getByText("Cancelado")).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
  await expect(card.getByTestId("refund-badge")).toHaveCount(0);

  // AND the seat is free again on the seat map
  await page.goto(seatsPath);
  await expect(page.getByTitle(`${seatLabel} — Disponível`)).toBeVisible();

  // AND a booking cancelled without a payment is no longer listed after reloading
  await openMyTickets(page);
  await expect(page.getByText("Você ainda não tem ingressos confirmados.")).toBeVisible();
});
