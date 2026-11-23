import { expect, test } from "@playwright/test";
import {
  apiError,
  cancelledWithRefund,
  mockTicket,
  stubCancelResponses,
  stubMyTickets,
} from "./helpers/refunds";
import { confirmCancellation, openCancelDialog, openMyTickets, registerAndLogin, ticketCard } from "./helpers/tickets";

// Spec: docs/flows/refund/spec.md (AC27–AC29).
//
// Refunds go through Mercado Pago's Refunds API, which e2e can't reach (see
// helpers/refunds.ts): the customer logs in for real, and only the
// "Meus ingressos" and cancel responses are stubbed, with the backend's shapes.

test("AC27: deve esconder o botão Cancelar e avisar que o cancelamento encerrou depois do prazo", async ({ page }) => {
  // GIVEN a confirmed ticket for a session starting in 1 hour (past the 2-hour deadline)
  await stubMyTickets(page, [mockTicket({ movieTitle: "Sessão Próxima", hoursAhead: 1 })]);
  await registerAndLogin(page, "refund-deadline");

  // WHEN the customer opens "Meus ingressos"
  await openMyTickets(page);

  // THEN there is no cancel button, only the closed-cancellation notice
  const card = ticketCard(page, "Sessão Próxima");
  await expect(card.getByText("Cancelamento encerrado (até 2 horas antes da sessão)")).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
});

test("AC28: deve manter o ingresso cancelado na lista com o selo Estorno em andamento", async ({ page }) => {
  // GIVEN a paid confirmed ticket whose refund the provider accepts
  const ticket = mockTicket({ movieTitle: "Filme Estornável" });
  await stubMyTickets(page, [ticket]);
  const cancelCalls = await stubCancelResponses(page, [cancelledWithRefund(ticket, "pending")]);
  await registerAndLogin(page, "refund-pending");
  await openMyTickets(page);

  // WHEN the customer cancels it
  const dialog = await openCancelDialog(page, "Filme Estornável");
  await expect(dialog).toContainText("o valor de R$ 50,00 será estornado integralmente");
  await confirmCancellation(dialog);

  // THEN the ticket stays in the list, cancelled, with the pending refund badge
  const card = ticketCard(page, "Filme Estornável");
  await expect(card.getByText("Ingresso cancelado. Estorno em andamento.")).toBeVisible();
  await expect(card.getByText("Cancelado", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
  expect(cancelCalls).toEqual([ticket.bookingId]);
});

test("AC28: deve mostrar a mensagem do back quando o estorno é recusado", async ({ page }) => {
  // GIVEN a paid confirmed ticket whose refund the provider rejects
  const ticket = mockTicket({ movieTitle: "Filme Recusado" });
  await stubMyTickets(page, [ticket]);
  await stubCancelResponses(page, [
    apiError(422, "REFUND_REJECTED", "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido."),
  ]);
  await registerAndLogin(page, "refund-rejected");
  await openMyTickets(page);

  // WHEN the customer tries to cancel it
  await confirmCancellation(await openCancelDialog(page, "Filme Recusado"));

  // THEN the backend message is shown and the ticket is still valid
  await expect(page.getByRole("alert")).toHaveText(
    "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
  );
  await expect(ticketCard(page, "Filme Recusado").getByRole("button", { name: "Cancelar" })).toBeVisible();
});

test("AC28: deve mostrar Tentar de novo quando o provedor não responde e reenviar o cancelamento", async ({ page }) => {
  // GIVEN the first cancel times out at the provider and the retry is accepted
  const ticket = mockTicket({ movieTitle: "Filme Lento" });
  await stubMyTickets(page, [ticket]);
  const cancelCalls = await stubCancelResponses(page, [
    apiError(504, "REFUND_PROVIDER_TIMEOUT", "O provedor de pagamento não respondeu a tempo. Tente novamente."),
    cancelledWithRefund(ticket, "pending"),
  ]);
  await registerAndLogin(page, "refund-timeout");
  await openMyTickets(page);
  const dialog = await openCancelDialog(page, "Filme Lento");

  // WHEN the first attempt times out
  await confirmCancellation(dialog);

  // THEN the dialog stays open with the message and a retry button
  await expect(dialog.getByRole("alert")).toHaveText("O provedor de pagamento não respondeu a tempo. Tente novamente.");

  // WHEN the customer retries
  await dialog.getByRole("button", { name: "Tentar de novo" }).click();

  // THEN the same booking is cancelled again and the ticket shows the pending refund
  await expect(ticketCard(page, "Filme Lento").getByText("Ingresso cancelado. Estorno em andamento.")).toBeVisible();
  expect(cancelCalls).toEqual([ticket.bookingId, ticket.bookingId]);
});

test("AC29: deve mostrar Estorno em andamento no ingresso cancelado com estorno pendente", async ({ page }) => {
  // GIVEN a cancelled ticket whose refund is still pending
  await stubMyTickets(page, [mockTicket({ movieTitle: "Filme Pendente", status: "cancelled", refundStatus: "pending" })]);
  await registerAndLogin(page, "refund-badge-pending");

  // WHEN the customer opens "Meus ingressos"
  await openMyTickets(page);

  // THEN the pending badge is shown
  await expect(ticketCard(page, "Filme Pendente").getByText("Ingresso cancelado. Estorno em andamento.")).toBeVisible();
});

test("AC29: deve mostrar Estorno concluído no ingresso com estorno aprovado", async ({ page }) => {
  // GIVEN a cancelled ticket whose refund was approved
  await stubMyTickets(page, [
    mockTicket({ movieTitle: "Filme Concluído", status: "cancelled", refundStatus: "completed" }),
  ]);
  await registerAndLogin(page, "refund-badge-completed");

  // WHEN the customer opens "Meus ingressos"
  await openMyTickets(page);

  // THEN the completed badge is shown
  await expect(ticketCard(page, "Filme Concluído").getByText("Ingresso cancelado e estornado.")).toBeVisible();
});

test("AC29: deve mostrar a mensagem de falha no ingresso cancelado com estorno que falhou", async ({ page }) => {
  // GIVEN a cancelled ticket whose refund failed
  await stubMyTickets(page, [mockTicket({ movieTitle: "Filme Falhou", status: "cancelled", refundStatus: "failed" })]);
  await registerAndLogin(page, "refund-badge-failed");

  // WHEN the customer opens "Meus ingressos"
  await openMyTickets(page);

  // THEN the failure message is shown
  await expect(
    ticketCard(page, "Filme Falhou").getByText("Não foi possível estornar. Nossa equipe vai analisar."),
  ).toBeVisible();
});
