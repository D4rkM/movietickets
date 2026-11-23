import { expect, test } from "@playwright/test";
import { loginAsAdmin, openAdminFromProfileMenu } from "./helpers/admin";
import { apiError, mockReviewItem, openAdminRefunds, reviewRow, stubRefundReviewQueue } from "./helpers/refunds";

// Spec: docs/flows/refund/spec.md (AC30).
//
// The admin logs in for real. Except for the first test, which reads the real
// queue, the queue and refund responses are stubbed with the backend's shapes:
// a refund needs an approved Mercado Pago payment, which e2e can't create
// (see helpers/refunds.ts).

test("AC30: deve abrir a fila de estornos real pelo link Estornos do painel admin", async ({ page }) => {
  // GIVEN an authenticated admin on the admin home
  await loginAsAdmin(page);
  await openAdminFromProfileMenu(page);

  // WHEN they follow the "Estornos" link
  await page.getByRole("navigation", { name: "Navegação admin" }).getByRole("link", { name: "Estornos" }).click();

  // THEN the real review queue loads (empty or not) without an error
  await expect(page).toHaveURL(/\/admin\/refunds$/);
  await expect(page.getByRole("heading", { name: "Estornos" })).toBeVisible();
  await expect(page.getByText("Nenhuma reserva aguardando estorno.").or(page.getByRole("table"))).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("AC30: deve listar a fila com o motivo da revisão em pt-BR", async ({ page }) => {
  // GIVEN one queued booking per review reason
  await stubRefundReviewQueue(page, [
    mockReviewItem({ customerEmail: "expirada@test.com", reviewReason: "expired_booking_paid" }),
    mockReviewItem({ customerEmail: "recusado@test.com", reviewReason: "refund_rejected", refundStatus: "rejected" }),
    mockReviewItem({ customerEmail: "parado@test.com", reviewReason: "refund_stalled", refundStatus: "requested" }),
  ]);
  await loginAsAdmin(page);

  // WHEN the admin opens /admin/refunds
  await openAdminRefunds(page);

  // THEN each row shows its reason in Portuguese
  await expect(reviewRow(page, "expirada@test.com")).toContainText("Pagamento aprovado em reserva expirada");
  await expect(reviewRow(page, "recusado@test.com")).toContainText("Estorno recusado");
  await expect(reviewRow(page, "parado@test.com")).toContainText("Estorno parado");
});

test("AC30: deve estornar após confirmação e recarregar a fila", async ({ page }) => {
  // GIVEN a paid expired booking in the queue
  const stub = await stubRefundReviewQueue(page, [
    mockReviewItem({ customerEmail: "cliente-estorno@test.com", reviewReason: "expired_booking_paid" }),
  ]);
  await loginAsAdmin(page);
  await openAdminRefunds(page);
  await expect(reviewRow(page, "cliente-estorno@test.com")).toBeVisible();
  const loadsBeforeRefund = stub.loads;
  let confirmMessage = "";
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    void dialog.accept();
  });

  // WHEN the admin clicks "Estornar" and confirms
  await reviewRow(page, "cliente-estorno@test.com").getByRole("button", { name: "Estornar" }).click();

  // THEN the refund was requested after a confirmation with amount and customer
  await expect(page.getByRole("status")).toHaveText("Estorno de cliente-estorno@test.com: Aprovado.");
  expect(confirmMessage).toBe("Estornar R$ 50,00 para cliente-estorno@test.com?");
  expect(stub.refundCalls).toHaveLength(1);
  // AND the reloaded queue no longer has the booking
  await expect(page.getByText("Nenhuma reserva aguardando estorno.")).toBeVisible();
  expect(stub.loads).toBe(loadsBeforeRefund + 1);
});

test("AC30: deve mostrar Atualizar status quando o estorno está em andamento", async ({ page }) => {
  // GIVEN a queued booking whose refund is in_process
  const stub = await stubRefundReviewQueue(page, [
    mockReviewItem({ customerEmail: "em-andamento@test.com", reviewReason: "expired_booking_paid", refundStatus: "in_process" }),
  ]);
  await loginAsAdmin(page);
  await openAdminRefunds(page);
  const row = reviewRow(page, "em-andamento@test.com");
  await expect(row.getByRole("button", { name: "Estornar" })).toHaveCount(0);

  // WHEN the admin clicks "Atualizar status"
  await row.getByRole("button", { name: "Atualizar status" }).click();

  // THEN the same endpoint reconciles it and the queue reloads
  await expect(page.getByText("Nenhuma reserva aguardando estorno.")).toBeVisible();
  expect(stub.refundCalls).toHaveLength(1);
});

test("AC30: deve mostrar a mensagem do back quando o estorno falha", async ({ page }) => {
  // GIVEN the provider rejects the refund
  await stubRefundReviewQueue(
    page,
    [mockReviewItem({ customerEmail: "falha@test.com", reviewReason: "expired_booking_paid" })],
    () => apiError(422, "REFUND_REJECTED", "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido."),
  );
  await loginAsAdmin(page);
  await openAdminRefunds(page);
  page.once("dialog", (dialog) => void dialog.accept());

  // WHEN the admin clicks "Estornar" and confirms
  await reviewRow(page, "falha@test.com").getByRole("button", { name: "Estornar" }).click();

  // THEN the backend message is shown and the booking is still queued
  await expect(page.getByRole("alert")).toHaveText(
    "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
  );
  await expect(reviewRow(page, "falha@test.com")).toBeVisible();
});
