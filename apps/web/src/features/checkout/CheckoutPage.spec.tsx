import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceToPaymentStep,
  createMockMercadoPago,
  DEFAULT_PAYMENT_SUMMARY,
  fillValidPaymentForm,
  renderCheckoutPage,
  setupCheckoutApiMocks,
} from "../../test/helpers/checkout";

vi.mock("@mercadopago/sdk-js", () => ({
  loadMercadoPago: vi.fn().mockResolvedValue(undefined),
}));

describe("CheckoutPage (integration)", () => {
  beforeEach(() => {
    localStorage.setItem("movietickets:accessToken", "token-123");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    delete window.MercadoPago;
    vi.unstubAllGlobals();
  });

  it("deve redirecionar para /movies quando não houver estado de checkout", async () => {
    // GIVEN the page is reached without going through seat selection
    renderCheckoutPage(null);

    // WHEN it renders
    // THEN it redirects to the movies page
    expect(await screen.findByText("Movies page")).toBeInTheDocument();
  });

  it("deve pedir confirmação antes de cancelar e permanecer na página ao desistir", async () => {
    // GIVEN the order summary has loaded
    setupCheckoutApiMocks();
    renderCheckoutPage();
    await screen.findByText("Assento A1");

    // WHEN the user clicks back and then dismisses the confirmation
    await userEvent.click(screen.getByRole("button", { name: "← Voltar" }));
    expect(screen.getByText("Deseja mesmo cancelar a reserva?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Não" }));

    // THEN the modal closes and the user stays on the checkout page
    expect(screen.queryByText("Deseja mesmo cancelar a reserva?")).not.toBeInTheDocument();
    expect(screen.getByText("Resumo do pedido")).toBeInTheDocument();
  });

  it("deve cancelar e voltar ao catálogo ao confirmar, sem criar reserva", async () => {
    // GIVEN the order summary has loaded
    setupCheckoutApiMocks();
    renderCheckoutPage();
    await screen.findByText("Assento A1");

    // WHEN the user clicks back and confirms the cancellation
    await userEvent.click(screen.getByRole("button", { name: "← Voltar" }));
    await userEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));

    // THEN it navigates to the catalog, with no booking request ever made, and the hold is released
    expect(await screen.findByText("Movies page")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/book"), expect.anything());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/session-1/holds"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deve reduzir o preço pela metade e exigir documento ao escolher meia-entrada", async () => {
    // GIVEN a session with one selected seat
    createMockMercadoPago();
    const { bookBodies } = setupCheckoutApiMocks();
    renderCheckoutPage();
    await screen.findByText("Assento A1");

    // WHEN the user picks "Meia" without filling the document
    await userEvent.click(screen.getByRole("radio", { name: "Meia" }));

    // THEN the price halves and the continue button is disabled until a document is entered
    expect(screen.getByText("Total: R$ 12.50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuar para pagamento" })).toBeDisabled();

    // WHEN the user fills the document and continues to payment
    await userEvent.type(screen.getByLabelText("Documento da meia-entrada"), "1234567890");
    await userEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));

    // THEN it books the seat as a half ticket with the document and locks ticket choices on the payment step
    expect(await screen.findByRole("heading", { name: "Pagamento com cartão" })).toBeInTheDocument();
    expect(bookBodies).toEqual([
      { seats: [{ seatId: "seat-1", ticketType: "half", halfPriceDocument: "1234567890" }] },
    ]);
    expect(screen.queryByRole("radio", { name: "Inteira" })).not.toBeInTheDocument();
  });

  it("deve redirecionar para /login quando a reserva responder 401 (token expirado)", async () => {
    // GIVEN the seat map summary loads fine, but the token expires before continuing to payment
    setupCheckoutApiMocks({
      bookResponse: async () => ({ ok: false, status: 401 }) as Response,
    });
    const originalLocation = window.location;
    // @ts-expect-error -- replacing location with a mock to observe the redirect
    delete window.location;
    // @ts-expect-error -- partial Location mock is enough to observe href
    window.location = { ...originalLocation, href: "" };
    renderCheckoutPage();

    // WHEN the user clicks to continue to payment
    await screen.findByText("Assento A1");
    await userEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));

    // THEN it clears the stale token and redirects to the login page
    await vi.waitFor(() => expect(window.location.href).toBe("/login"));
    expect(localStorage.getItem("movietickets:accessToken")).toBeNull();

    // @ts-expect-error -- restoring the original Location object
    window.location = originalLocation;
  });

  it("deve exibir erro e não avançar para pagamento quando a reserva atômica falhar", async () => {
    // GIVEN a seat that is already taken by another user (backend returns 409 without bookingId)
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks({
      bookResponse: async () => ({ ok: false, status: 409 }) as Response,
    });
    renderCheckoutPage();
    await screen.findByText("Assento A1");

    // WHEN the user clicks to continue to payment
    await userEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));

    // THEN it shows the error, stays on step 1 without mounting card fields, and re-enables the button
    expect(await screen.findByRole("alert")).toHaveTextContent(/status 409/);
    expect(mp.createFieldSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continuar para pagamento" })).toBeEnabled();
  });

  it("AC2: deve montar número, validade e código de segurança via mp.fields.create sem renderizar inputs próprios para dados do cartão", async () => {
    // GIVEN the user advances to the payment step
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();

    // WHEN the payment step mounts
    await advanceToPaymentStep();

    // THEN it creates and mounts cardNumber, expirationDate, and securityCode via MercadoPago.js
    expect(mp.createFieldSpy).toHaveBeenCalledWith("cardNumber", expect.any(Object));
    expect(mp.createFieldSpy).toHaveBeenCalledWith("expirationDate", expect.any(Object));
    expect(mp.createFieldSpy).toHaveBeenCalledWith("securityCode", expect.any(Object));
    expect(mp.fields.cardNumber.mount).toHaveBeenCalledWith("mp-card-number");
    expect(mp.fields.expirationDate.mount).toHaveBeenCalledWith("mp-expiration-date");
    expect(mp.fields.securityCode.mount).toHaveBeenCalledWith("mp-security-code");

    // AND the only inputs in the DOM are cardholder name, CPF, and e-mail (no input for card number, expiry, or CVV)
    expect(within(screen.getByTestId("mp-card-number")).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("mp-expiration-date")).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("mp-security-code")).queryByRole("textbox")).not.toBeInTheDocument();
    const allInputs = document.querySelectorAll("input");
    expect(allInputs).toHaveLength(3);
  });

  it("AC3: deve detectar a bandeira pelo BIN, ocultar emissor quando não exigido, carregar parcelas com o valor do resumo e limpar ao apagar o BIN", async () => {
    // GIVEN a card brand that does not require issuer_id in additional_info_needed
    const mp = createMockMercadoPago({
      paymentMethods: [
        {
          id: "visa",
          name: "Visa",
          additional_info_needed: [],
          issuer: { id: 25, name: "Itaú" },
        },
      ],
    });
    setupCheckoutApiMocks({
      summaryResponse: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ...DEFAULT_PAYMENT_SUMMARY, amountCents: 5000 }),
        }) as Response,
    });
    await advanceToPaymentStep();

    // WHEN the user types a 6-digit BIN
    await mp.fields.cardNumber.emitBinChange({ bin: "411111" });

    // THEN it detects the brand, loads installments with the server summary amount (50), and hides the issuer select
    expect(mp.getPaymentMethodsSpy).toHaveBeenCalledWith({ bin: "411111" });
    expect(mp.getInstallmentsSpy).toHaveBeenCalledWith({
      amount: "50",
      bin: "411111",
      paymentTypeId: "credit_card",
    });
    expect(mp.getIssuersSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("Bandeira: Visa")).toBeInTheDocument();
    expect(screen.queryByLabelText("Banco emissor")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1x de R$ 25,00 sem juros" })).toBeInTheDocument();

    // WHEN the user clears the BIN
    await mp.fields.cardNumber.emitBinChange({ bin: "" });

    // THEN brand, issuer, and installment options are cleared
    expect(screen.queryByText("Bandeira: Visa")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "1x de R$ 25,00 sem juros" })).not.toBeInTheDocument();
  });

  it("AC3: deve exibir o select de emissor quando additional_info_needed incluir issuer_id", async () => {
    // GIVEN a card brand whose additional_info_needed includes issuer_id
    const mp = createMockMercadoPago({
      paymentMethods: [
        {
          id: "master",
          name: "Mastercard",
          additional_info_needed: ["issuer_id"],
          issuer: { id: 10, name: "Genérico" },
        },
      ],
      issuers: [
        { id: "310", name: "Nubank" },
        { id: "341", name: "Itaú" },
      ],
    });
    setupCheckoutApiMocks();
    await advanceToPaymentStep();

    // WHEN the user types the card BIN
    await mp.fields.cardNumber.emitBinChange({ bin: "511111" });

    // THEN it queries getIssuers and renders the issuer select with the returned options
    expect(mp.getIssuersSpy).toHaveBeenCalledWith({ paymentMethodId: "master", bin: "511111" });
    const issuerSelect = await screen.findByLabelText("Banco emissor");
    expect(issuerSelect).toBeInTheDocument();
    expect(within(issuerSelect).getByRole("option", { name: "Nubank" })).toBeInTheDocument();
    expect(within(issuerSelect).getByRole("option", { name: "Itaú" })).toBeInTheDocument();
  });

  it("AC4: deve carregar tipos de documento de getIdentificationTypes e bloquear geração de token quando o nome do titular estiver vazio", async () => {
    // GIVEN the payment step is mounted with identification types from the SDK
    const mp = createMockMercadoPago({
      identificationTypes: [
        { id: "CPF", name: "CPF" },
        { id: "CNPJ", name: "CNPJ" },
      ],
    });
    setupCheckoutApiMocks();
    await advanceToPaymentStep();

    // WHEN all fields except the cardholder name are filled and the user clicks Pagar
    expect(mp.getIdentificationTypesSpy).toHaveBeenCalled();
    expect(within(screen.getByLabelText("Tipo de documento")).getByRole("option", { name: "CPF" })).toBeInTheDocument();
    await fillValidPaymentForm(mp, { cardholderName: "" });
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN a pt-BR message is shown on the field and createCardToken is not called
    expect(screen.getByText("Informe o nome do titular.")).toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
  });

  it("AC4: deve mostrar mensagem em pt-BR e não gerar token quando o CPF for inválido", async () => {
    // GIVEN the payment step is mounted
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    await advanceToPaymentStep();

    // WHEN the user enters a CPF with an invalid check digit and clicks Pagar
    await fillValidPaymentForm(mp, { cpf: "52998224726" });
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN a pt-BR message is shown on the CPF field and createCardToken is not called
    expect(screen.getByText("CPF inválido.")).toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
  });

  it("AC4: deve mostrar mensagem em pt-BR e não gerar token quando o e-mail for inválido", async () => {
    // GIVEN the payment step is mounted
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    await advanceToPaymentStep();

    // WHEN the user enters an invalid e-mail and clicks Pagar
    await fillValidPaymentForm(mp, { email: "email-invalido" });
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN a pt-BR message is shown on the e-mail field and createCardToken is not called
    expect(screen.getByText("Informe um e-mail válido.")).toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
  });

  it("AC4: deve mostrar mensagem em pt-BR e não gerar token quando as parcelas não forem escolhidas", async () => {
    // GIVEN the payment step is mounted and installment options loaded
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    await advanceToPaymentStep();

    // WHEN the user fills everything except choosing an installment option and clicks Pagar
    await fillValidPaymentForm(mp, { installments: "" });
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN a pt-BR message is shown on the installments field and createCardToken is not called
    expect(screen.getByText("Selecione o número de parcelas.")).toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
  });

  it("AC4: deve mostrar mensagem em pt-BR e não gerar token quando um campo seguro emitir erro de validade", async () => {
    // GIVEN the payment step is mounted and all our own fields are valid
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    await advanceToPaymentStep();
    await fillValidPaymentForm(mp);

    // WHEN the secure cardNumber field reports an invalid state via validityChange and the user clicks Pagar
    await mp.fields.cardNumber.emitValidityChange({
      errorMessages: [{ message: "Invalid card number", cause: "invalid_length" }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN our pt-BR message is displayed for that secure field and createCardToken is not called
    expect(screen.getByText("Número do cartão inválido.")).toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
  });

  it("AC2: deve encontrar os containers no DOM ao montar os campos seguros, sem erro de carregamento", async () => {
    // GIVEN a MercadoPago.js mock that, like the real SDK, resolves the container by id and fails when it is missing
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // WHEN the payment step mounts the secure fields
    await advanceToPaymentStep();

    // THEN each secure iframe lands inside its own container
    await vi.waitFor(() => expect(mp.fields.securityCode.mount).toHaveBeenCalled());
    expect(screen.getByTestId("mp-card-number").querySelector('iframe[data-mp-field="cardNumber"]')).not.toBeNull();
    expect(screen.getByTestId("mp-expiration-date").querySelector('iframe[data-mp-field="expirationDate"]')).not.toBeNull();
    expect(screen.getByTestId("mp-security-code").querySelector('iframe[data-mp-field="securityCode"]')).not.toBeNull();

    // AND no load or validation error is shown before the user types anything
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Não foi possível carregar o campo do cartão/)).not.toBeInTheDocument();
    expect(screen.queryByText(/inválid[ao]\./)).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("AC2: deve exibir erro de carregamento, e não 'inválido', quando o SDK falhar ao montar um campo seguro", async () => {
    // GIVEN the payment step is mounted and all our own fields are valid
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await advanceToPaymentStep();
    await fillValidPaymentForm(mp);

    // WHEN the SDK reports a failure on the card number field
    const sdkError = {
      field: "cardNumber",
      error: "MercadoPago.js - Error when mounting field mp-card-number: Container not found",
    };
    await mp.fields.cardNumber.emitError(sdkError);

    // THEN the user sees the load error instead of an "invalid" message, and the real cause is logged
    expect(screen.getByText("Não foi possível carregar o campo do cartão. Recarregue a página.")).toBeInTheDocument();
    expect(screen.queryByText("Número do cartão inválido.")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("cardNumber"), sdkError);

    // WHEN the user still tries to pay
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN the load error stays and no card token is requested
    expect(screen.getByText("Não foi possível carregar o campo do cartão. Recarregue a página.")).toBeInTheDocument();
    expect(screen.queryByText("Número do cartão inválido.")).not.toBeInTheDocument();
    expect(mp.createCardTokenSpy).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("AC5: deve gerar token com createCardToken e enviar apenas os campos permitidos em POST /bookings/:id/payments", async () => {
    // GIVEN a valid payment form
    const mp = createMockMercadoPago({ tokens: ["card-token-xyz"] });
    const { paymentBodies } = setupCheckoutApiMocks();
    await advanceToPaymentStep();
    await fillValidPaymentForm(mp, {
      cardholderName: "Maria Silva",
      cpf: "529.982.247-25",
      email: "maria@example.com",
      installments: "2",
    });

    // WHEN the user submits the payment
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN it generates the single-use card token and sends only the whitelisted payload keys
    expect(await screen.findByRole("heading", { name: "Pagamento aprovado!" })).toBeInTheDocument();
    expect(mp.createCardTokenSpy).toHaveBeenCalledWith({
      cardholderName: "Maria Silva",
      identificationType: "CPF",
      identificationNumber: "52998224725",
    });
    expect(paymentBodies).toHaveLength(1);
    expect(Object.keys(paymentBodies[0]).sort()).toEqual([
      "attemptId",
      "installments",
      "issuerId",
      "payer",
      "paymentMethodId",
      "token",
    ]);
    expect(paymentBodies[0]).toEqual({
      attemptId: expect.any(String),
      token: "card-token-xyz",
      paymentMethodId: "visa",
      issuerId: "25",
      installments: 2,
      payer: {
        email: "maria@example.com",
        identification: {
          type: "CPF",
          number: "52998224725",
        },
      },
    });
  });

  it("AC6: deve chamar bookSeats uma única vez e, após recusa do cartão, gerar novo attemptId e novo token mantendo o mesmo bookingId", async () => {
    // GIVEN the user advances to payment and the first card attempt is rejected
    const mp = createMockMercadoPago({ tokens: ["tok-attempt-1", "tok-attempt-2"] });
    const { bookBodies, paymentBodies } = setupCheckoutApiMocks({
      paymentResponse: async (body, callIndex) => {
        if (callIndex === 0) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              attemptId: body.attemptId,
              paymentId: "mp-1",
              status: "rejected",
              statusDetail: "cc_rejected_insufficient_amount",
              message: "Saldo ou limite insuficiente. Use outro cartão.",
              bookingStatus: "pending",
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            attemptId: body.attemptId,
            paymentId: "mp-2",
            status: "approved",
            statusDetail: "accredited",
            message: "Pagamento aprovado!",
            bookingStatus: "confirmed",
          }),
        } as Response;
      },
    });

    await advanceToPaymentStep();
    await fillValidPaymentForm(mp);

    // WHEN the first attempt is rejected and the user clicks Pagar again
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Saldo ou limite insuficiente. Use outro cartão.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));
    expect(await screen.findByRole("heading", { name: "Pagamento aprovado!" })).toBeInTheDocument();

    // THEN bookSeats was called only once, createCardToken was called twice, and the two POSTs used distinct attemptIds and tokens on the same bookingId
    expect(bookBodies).toHaveLength(1);
    expect(mp.createCardTokenSpy).toHaveBeenCalledTimes(2);
    expect(paymentBodies).toHaveLength(2);
    expect(paymentBodies[0].token).toBe("tok-attempt-1");
    expect(paymentBodies[1].token).toBe("tok-attempt-2");
    expect(paymentBodies[0].attemptId).not.toBe(paymentBodies[1].attemptId);
  });

  it("AC6: deve reenviar o mesmo attemptId e o mesmo token ao clicar em 'Tentar de novo' após falha sem resposta (504 ou rede)", async () => {
    // GIVEN the first payment call times out with 504 PAYMENT_PROVIDER_TIMEOUT
    const mp = createMockMercadoPago({ tokens: ["tok-replay-1", "tok-unused-2"] });
    const { bookBodies, paymentBodies } = setupCheckoutApiMocks({
      paymentResponse: async (body, callIndex) => {
        if (callIndex === 0) {
          return {
            ok: false,
            status: 504,
            json: async () => ({
              statusCode: 504,
              code: "PAYMENT_PROVIDER_TIMEOUT",
              message: "O provedor de pagamento não respondeu a tempo.",
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            attemptId: body.attemptId,
            paymentId: "mp-replay-ok",
            status: "in_process",
            statusDetail: "pending_contingency",
            message: "Pagamento em análise. Você recebe a confirmação por e-mail.",
            bookingStatus: "pending",
          }),
        } as Response;
      },
    });

    await advanceToPaymentStep();
    await fillValidPaymentForm(mp);

    // WHEN the first submission fails with 504 and the user clicks "Tentar de novo"
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O provedor de pagamento não respondeu a tempo.",
    );

    const retryButton = screen.getByRole("button", { name: "Tentar de novo" });
    await userEvent.click(retryButton);

    // THEN it replays the exact same attemptId and token without calling createCardToken or bookSeats again, and shows the in-analysis state
    expect(await screen.findByRole("heading", { name: "Pagamento em análise" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pagamento em análise. Você recebe a confirmação por e-mail e o ingresso aparece em Meus ingressos.",
      ),
    ).toBeInTheDocument();
    expect(bookBodies).toHaveLength(1);
    expect(mp.createCardTokenSpy).toHaveBeenCalledTimes(1);
    expect(paymentBodies).toHaveLength(2);
    expect(paymentBodies[1].attemptId).toBe(paymentBodies[0].attemptId);
    expect(paymentBodies[1].token).toBe("tok-replay-1");
  });

  it("AC7: deve retomar a reserva existente e avançar direto para a etapa de pagamento quando bookSeats responder 409 BOOKING_ALREADY_PENDING", async () => {
    // GIVEN the user already has a pending booking for the same seats (backend returns 409 BOOKING_ALREADY_PENDING with bookingId)
    createMockMercadoPago();
    const summaryUrls: string[] = [];
    setupCheckoutApiMocks({
      bookResponse: async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: "BOOKING_ALREADY_PENDING",
            bookingId: "booking-existing-99",
            message: "Você já tem uma reserva pendente para esses assentos.",
          }),
        }) as Response,
      summaryResponse: async () => {
        summaryUrls.push("booking-existing-99");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...DEFAULT_PAYMENT_SUMMARY,
            bookingId: "booking-existing-99",
          }),
        } as Response;
      },
    });

    renderCheckoutPage();
    await screen.findByText("Assento A1");

    // WHEN the user clicks "Continuar para pagamento"
    await userEvent.click(screen.getByRole("button", { name: "Continuar para pagamento" }));

    // THEN it advances straight to the payment step using the returned bookingId without showing an error
    expect(await screen.findByRole("heading", { name: "Pagamento com cartão" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(summaryUrls).toEqual(["booking-existing-99"]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/bookings/booking-existing-99/payment-summary"),
      expect.anything(),
    );
  });

  it("AC16: deve exibir o aviso de reserva expirada com link para escolher assentos quando o resumo ou pagamento responder 409 BOOKING_EXPIRED", async () => {
    // GIVEN the booking succeeds, the user fills the card form, and the booking expires before payment is submitted
    const mp = createMockMercadoPago();
    setupCheckoutApiMocks({
      paymentResponse: async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: "BOOKING_EXPIRED",
            message: "Reserva expirada. Escolha os assentos novamente.",
          }),
        }) as Response,
    });
    await advanceToPaymentStep();
    await fillValidPaymentForm(mp);

    // WHEN the user tries to pay
    await userEvent.click(screen.getByRole("button", { name: "Pagar" }));

    // THEN it shows the expired-booking message, disables paying again, and links back to the session's seat selection
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sua reserva expirou. Escolha os assentos novamente.",
    );
    expect(screen.getByRole("button", { name: "Pagar" })).toBeDisabled();
    const backToSeats = screen.getByRole("link", { name: "Escolher assentos" });
    expect(backToSeats).toHaveAttribute("href", "/sessions/session-1/seats");
    await userEvent.click(backToSeats);
    expect(await screen.findByText("Seat selection page")).toBeInTheDocument();
  });
});
