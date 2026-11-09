import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";

export const STUB_CARD_TOKEN = "e2e-stub-card-token";

/**
 * Stand-in for MercadoPago.js v2 (https://sdk.mercadopago.com/js/v2). The real
 * SDK renders PCI iframes hosted by Mercado Pago and tokenizes against their
 * servers, which e2e can't drive deterministically. This stub implements the
 * same Core Methods surface the checkout page uses: secure fields become plain
 * inputs mounted in the same containers, typing a card number fires
 * `binChange`, and `createCardToken` resolves a fixed token.
 *
 * Mounting follows the real SDK's contract so the stub can't hide a broken
 * mount: `mount` resolves a bare container id with `document.getElementById`
 * (a "#..." selector or a missing container fails), a failure only warns and
 * emits an async `error` event (it doesn't throw), `unmount` throws when the
 * field isn't mounted, and creating a field type that is still mounted throws.
 */
const FAKE_SDK_SCRIPT = `
(() => {
  const mountedTypes = new Set();

  function createField(type, options) {
    if (mountedTypes.has(type)) {
      throw new Error("[Fields] The field " + type + " has already been created");
    }
    let mounted = false;
    const handlers = {};
    const input = document.createElement("input");
    input.setAttribute("aria-label", options && options.placeholder ? options.placeholder : type);
    input.setAttribute("data-mp-field", type);
    input.addEventListener("input", () => {
      if (type === "cardNumber") {
        const digits = input.value.replace(/\\D/g, "");
        (handlers.binChange || []).forEach((h) => h({ bin: digits.length >= 6 ? digits.slice(0, 6) : "" }));
      }
      (handlers.validityChange || []).forEach((h) => h({ isValid: true, errorMessages: [] }));
    });
    const field = {
      mount(containerId) {
        if (mounted) throw new Error("Field '" + type + "' already mounted");
        const el = document.getElementById(containerId);
        if (!el) {
          const message = "MercadoPago.js - Error when mounting field " + containerId + ": Container not found";
          console.warn(message);
          setTimeout(() => (handlers.error || []).forEach((h) => h({ field: type, error: message })));
          return field;
        }
        el.appendChild(input);
        mounted = true;
        mountedTypes.add(type);
        return field;
      },
      unmount() {
        if (!mounted) throw new Error("Field '" + type + "' already unmounted");
        input.remove();
        mounted = false;
        mountedTypes.delete(type);
      },
      on(event, handler) {
        (handlers[event] = handlers[event] || []).push(handler);
        return field;
      },
    };
    return field;
  }

  window.MercadoPago = function MercadoPago() {
    return {
      fields: {
        create: createField,
        createCardToken: async () => ({ id: "${STUB_CARD_TOKEN}" }),
      },
      getPaymentMethods: async () => ({
        results: [{ id: "visa", name: "Visa", issuer: { id: 1, name: "Visa" } }],
      }),
      getIssuers: async () => [{ id: 1, name: "Visa" }],
      getInstallments: async () => [
        { payer_costs: [{ installments: 1, recommended_message: "1x sem juros" }] },
      ],
      getIdentificationTypes: async () => [{ id: "CPF", name: "CPF" }],
    };
  };
})();
`;

/** Serves the fake MercadoPago.js in place of the real SDK script. */
export async function stubMercadoPagoSdk(page: Page): Promise<void> {
  await page.route(/^https:\/\/sdk\.mercadopago\.com\/js\/v2/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_SDK_SCRIPT }),
  );
}

/**
 * Intercepts `POST /bookings/:id/payments` so no real charge is attempted
 * against Mercado Pago (CI only has a placeholder access token). The booking is
 * still confirmed in the real backend, through the real `POST /bookings/:id/confirm`
 * route, standing in for the approved charge — so everything after the payment
 * (tickets list, cancellation, seat release) runs against real state.
 *
 * Returns the request bodies the page sent, so the test can check the payload
 * the checkout UI built from the form.
 */
export async function approvePaymentsThroughRealConfirm(page: Page): Promise<Array<Record<string, unknown>>> {
  const sentPayloads: Array<Record<string, unknown>> = [];
  await page.route("**/bookings/*/payments", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();

    const bookingId = new URL(request.url()).pathname.split("/")[2];
    const authorization = request.headers()["authorization"];
    sentPayloads.push(request.postDataJSON() as Record<string, unknown>);

    const confirmResponse = await fetch(`${API_URL}/bookings/${bookingId}/confirm`, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(confirmResponse.ok, `confirm booking ${bookingId} returned ${confirmResponse.status}`).toBe(true);

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        attemptId: (sentPayloads.at(-1)?.attemptId as string) ?? "",
        paymentId: "e2e-stub-payment",
        status: "approved",
        statusDetail: "accredited",
        message: "",
        bookingStatus: "confirmed",
      }),
    });
  });
  return sentPayloads;
}

/** Fills the card form rendered with the stubbed SDK fields and submits it. */
export async function payWithStubbedCard(page: Page, payer: { name: string; cpf: string; email: string }): Promise<void> {
  await expect(page.getByRole("heading", { name: "Pagamento com cartão" })).toBeVisible();
  await page.locator('[data-mp-field="cardNumber"]').fill("4235647728025682");
  await expect(page.getByText("Bandeira: Visa")).toBeVisible();
  await page.locator('[data-mp-field="expirationDate"]').fill("11/30");
  await page.locator('[data-mp-field="securityCode"]').fill("123");
  await page.getByLabel("Parcelas").selectOption("1");
  await page.getByLabel("Nome do titular").fill(payer.name);
  await page.getByLabel("CPF", { exact: true }).fill(payer.cpf);
  await page.getByLabel("E-mail").fill(payer.email);
  await page.getByRole("button", { name: /^Pagar$/ }).click();
}
