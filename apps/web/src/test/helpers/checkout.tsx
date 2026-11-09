import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import { AuthProvider } from "../../features/auth/AuthContext";
import { CheckoutPage } from "../../features/checkout/CheckoutPage";
import type { PaymentAttemptResult, PaymentSummary } from "../../features/checkout/api";
import type {
  BinChangeEvent,
  MercadoPagoField,
  MercadoPagoIdentificationType,
  MercadoPagoInstallmentResult,
  MercadoPagoInstance,
  MercadoPagoIssuer,
  MercadoPagoPaymentMethod,
  SecureFieldErrorEvent,
  SecureFieldType,
  ValidityChangeEvent,
} from "../../features/checkout/mercadopago";

export interface MockSecureFieldController {
  mount: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
  emitBinChange: (event: BinChangeEvent) => Promise<void>;
  emitValidityChange: (event: ValidityChangeEvent) => Promise<void>;
  emitError: (event?: SecureFieldErrorEvent) => Promise<void>;
}

export interface MockMercadoPagoController {
  instance: MercadoPagoInstance;
  fields: Record<SecureFieldType, MockSecureFieldController>;
  createFieldSpy: ReturnType<typeof vi.fn>;
  createCardTokenSpy: ReturnType<typeof vi.fn>;
  getPaymentMethodsSpy: ReturnType<typeof vi.fn>;
  getIssuersSpy: ReturnType<typeof vi.fn>;
  getInstallmentsSpy: ReturnType<typeof vi.fn>;
  getIdentificationTypesSpy: ReturnType<typeof vi.fn>;
}

export function createMockMercadoPago(overrides?: {
  paymentMethods?: MercadoPagoPaymentMethod[];
  issuers?: MercadoPagoIssuer[];
  installments?: MercadoPagoInstallmentResult[];
  identificationTypes?: MercadoPagoIdentificationType[];
  tokens?: string[];
}): MockMercadoPagoController {
  const binHandlers: Partial<Record<SecureFieldType, Array<(event: BinChangeEvent) => void>>> = {};
  const validityHandlers: Partial<
    Record<SecureFieldType, Array<(event: ValidityChangeEvent) => void>>
  > = {};
  const errorHandlers: Partial<Record<SecureFieldType, Array<(event: SecureFieldErrorEvent) => void>>> = {};
  // Field types currently mounted, mirroring the SDK's registry: it refuses to
  // create a type that is already mounted until that field is unmounted.
  const mountedTypes = new Set<SecureFieldType>();

  const makeField = (type: SecureFieldType): { field: MercadoPagoField; controller: MockSecureFieldController } => {
    binHandlers[type] = [];
    validityHandlers[type] = [];
    errorHandlers[type] = [];

    let mounted = false;

    // Mirrors MercadoPago.js v2 `mount`: resolves the container with
    // `document.getElementById` (bare id, not a `#` selector), appends the
    // secure iframe on success, and on a missing container only warns and emits
    // an async `error` event instead of throwing.
    const mount = vi.fn((containerId: string) => {
      if (mounted) throw new Error(`Field '${type}' already mounted`);
      const container = document.getElementById(containerId);
      if (!container) {
        const message = `MercadoPago.js - Error when mounting field ${containerId}: Container not found`;
        console.warn(message);
        setTimeout(() => {
          act(() => {
            for (const h of errorHandlers[type] ?? []) {
              h({ field: type, error: message });
            }
          });
        });
        return field;
      }
      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-mp-field", type);
      container.appendChild(iframe);
      mounted = true;
      mountedTypes.add(type);
      return field;
    });

    // Mirrors the SDK: unmounting a field that is not mounted throws.
    const unmount = vi.fn(() => {
      if (!mounted) throw new Error(`Field '${type}' already unmounted`);
      document.querySelector(`iframe[data-mp-field="${type}"]`)?.remove();
      mounted = false;
      mountedTypes.delete(type);
    });

    const field: MercadoPagoField = {
      mount,
      unmount,
      on(event: "binChange" | "validityChange" | "error", handler: (payload: never) => void) {
        if (event === "binChange") {
          binHandlers[type]!.push(handler as (event: BinChangeEvent) => void);
        } else if (event === "validityChange") {
          validityHandlers[type]!.push(handler as (event: ValidityChangeEvent) => void);
        } else if (event === "error") {
          errorHandlers[type]!.push(handler as (event: SecureFieldErrorEvent) => void);
        }
        return field;
      },
    };

    const controller: MockSecureFieldController = {
      mount,
      unmount,
      emitBinChange: async (event: BinChangeEvent) => {
        await act(async () => {
          for (const h of binHandlers[type] ?? []) {
            await h(event);
          }
        });
      },
      emitValidityChange: async (event: ValidityChangeEvent) => {
        await act(async () => {
          for (const h of validityHandlers[type] ?? []) {
            h(event);
          }
        });
      },
      emitError: async (
        event: SecureFieldErrorEvent = { field: type, error: "MercadoPago.js - Secure field failed" },
      ) => {
        await act(async () => {
          for (const h of errorHandlers[type] ?? []) {
            h(event);
          }
        });
      },
    };

    return { field, controller };
  };

  const cardNumber = makeField("cardNumber");
  const expirationDate = makeField("expirationDate");
  const securityCode = makeField("securityCode");

  const fieldMap: Record<SecureFieldType, MercadoPagoField> = {
    cardNumber: cardNumber.field,
    expirationDate: expirationDate.field,
    securityCode: securityCode.field,
  };

  const createFieldSpy = vi.fn((type: SecureFieldType) => {
    if (mountedTypes.has(type)) throw new Error(`[Fields] The field ${type} has already been created`);
    return fieldMap[type];
  });

  let tokenIndex = 0;
  const tokenQueue = overrides?.tokens ?? ["tok-1", "tok-2", "tok-3"];
  const createCardTokenSpy = vi.fn(async () => {
    const id = tokenQueue[tokenIndex] ?? `tok-${tokenIndex + 1}`;
    tokenIndex += 1;
    return { id };
  });

  const getPaymentMethodsSpy = vi.fn(async () => ({
    results: overrides?.paymentMethods ?? [
      {
        id: "visa",
        name: "Visa",
        additional_info_needed: [],
        issuer: { id: 25, name: "Banco Itaú" },
      },
    ],
  }));

  const getIssuersSpy = vi.fn(async () =>
    overrides?.issuers ?? [
      { id: "310", name: "Nubank" },
      { id: "341", name: "Itaú" },
    ],
  );

  const getInstallmentsSpy = vi.fn(async () =>
    overrides?.installments ?? [
      {
        payer_costs: [
          { installments: 1, recommended_message: "1x de R$ 25,00 sem juros" },
          { installments: 2, recommended_message: "2x de R$ 12,50 sem juros" },
        ],
      },
    ],
  );

  const getIdentificationTypesSpy = vi.fn(async () =>
    overrides?.identificationTypes ?? [
      { id: "CPF", name: "CPF" },
      { id: "CNPJ", name: "CNPJ" },
    ],
  );

  const instance: MercadoPagoInstance = {
    fields: {
      create: createFieldSpy,
      createCardToken: createCardTokenSpy,
    },
    getPaymentMethods: getPaymentMethodsSpy,
    getIssuers: getIssuersSpy,
    getInstallments: getInstallmentsSpy,
    getIdentificationTypes: getIdentificationTypesSpy,
  };

  const MercadoPagoConstructor = vi.fn(function () {
    return instance;
  });
  window.MercadoPago = MercadoPagoConstructor as unknown as typeof window.MercadoPago;

  return {
    instance,
    fields: {
      cardNumber: cardNumber.controller,
      expirationDate: expirationDate.controller,
      securityCode: securityCode.controller,
    },
    createFieldSpy,
    createCardTokenSpy,
    getPaymentMethodsSpy,
    getIssuersSpy,
    getInstallmentsSpy,
    getIdentificationTypesSpy,
  };
}

export function renderCheckoutPage(
  locationState: unknown = { sessionId: "session-1", seatIds: ["seat-1"] },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/checkout", state: locationState }]}>
      <AuthProvider>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/movies" element={<p>Movies page</p>} />
          <Route path="/tickets" element={<p>Tickets page</p>} />
          <Route path="/sessions/:id/seats" element={<p>Seat selection page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const DEFAULT_PAYMENT_SUMMARY: PaymentSummary = {
  bookingId: "booking-1",
  status: "pending",
  expiresAt: "2026-11-08T12:10:00.000Z",
  amountCents: 2500,
  currency: "BRL",
  description: "Duna - A1",
  seats: [{ seatId: "seat-1", label: "A1", ticketType: "full", priceCents: 2500 }],
};

export interface MockCheckoutApiOptions {
  priceCents?: number;
  bookResponse?: () => Promise<Response>;
  summaryResponse?: () => Promise<Response>;
  paymentResponse?: (body: Record<string, unknown>, callIndex: number) => Promise<Response>;
}

export function setupCheckoutApiMocks(options: MockCheckoutApiOptions = {}) {
  const bookBodies: Array<Record<string, unknown>> = [];
  const paymentBodies: Array<Record<string, unknown>> = [];
  let paymentCallIndex = 0;

  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const urlString = url.toString();

    if (urlString.endsWith("/sessions/session-1/book")) {
      if (init?.body) {
        bookBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      }
      if (options.bookResponse) {
        return options.bookResponse();
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => [{ bookingId: "booking-1", seatId: "seat-1", priceCents: options.priceCents ?? 2500 }],
      } as Response);
    }

    if (urlString.includes("/payment-summary")) {
      if (options.summaryResponse) {
        return options.summaryResponse();
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => DEFAULT_PAYMENT_SUMMARY,
      } as Response);
    }

    if (urlString.endsWith("/payments") && init?.method === "POST") {
      const parsedBody = init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
      paymentBodies.push(parsedBody);
      const currentCall = paymentCallIndex;
      paymentCallIndex += 1;

      if (options.paymentResponse) {
        return options.paymentResponse(parsedBody, currentCall);
      }

      const defaultApproved: PaymentAttemptResult = {
        attemptId: String(parsedBody.attemptId ?? "attempt-1"),
        paymentId: "mp-pay-1",
        status: "approved",
        statusDetail: "accredited",
        message: "Pagamento aprovado!",
        bookingStatus: "confirmed",
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => defaultApproved,
      } as Response);
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        room: { rows: 1, seatsPerRow: 1 },
        priceCents: options.priceCents ?? 2500,
        seats: [{ id: "seat-1", rowLabel: "A", seatNumber: 1, status: "held_by_me" }],
      }),
    } as Response);
  });

  return { bookBodies, paymentBodies };
}

export async function advanceToPaymentStep() {
  renderCheckoutPage();
  await screen.findByText("Assento A1");
  await userEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));
  await screen.findByText("Número do cartão");
}

export async function fillValidPaymentForm(
  mp: MockMercadoPagoController,
  overrides?: {
    bin?: string;
    installments?: string;
    cardholderName?: string;
    cpf?: string;
    email?: string;
  },
) {
  await mp.fields.cardNumber.emitBinChange({ bin: overrides?.bin ?? "411111" });
  await screen.findByRole("option", { name: "1x de R$ 25,00 sem juros" });
  const installmentsValue = overrides?.installments ?? "1";
  if (installmentsValue) {
    await userEvent.selectOptions(screen.getByLabelText("Parcelas"), installmentsValue);
  }
  const nameValue = overrides?.cardholderName ?? "Maria Silva";
  if (nameValue) {
    await userEvent.clear(screen.getByLabelText("Nome do titular"));
    await userEvent.type(screen.getByLabelText("Nome do titular"), nameValue);
  }
  const cpfValue = overrides?.cpf ?? "52998224725";
  if (cpfValue) {
    await userEvent.clear(screen.getByLabelText("CPF"));
    await userEvent.type(screen.getByLabelText("CPF"), cpfValue);
  }
  const emailValue = overrides?.email ?? "maria@example.com";
  if (emailValue) {
    await userEvent.clear(screen.getByLabelText("E-mail"));
    await userEvent.type(screen.getByLabelText("E-mail"), emailValue);
  }
}
