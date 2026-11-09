import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { useAuth } from "../auth/AuthContext";
import { bookSeats, getSeatMap, releaseAllHolds } from "../seating/api";
import type { SeatMapSeat, TicketType } from "../seating/types";
import {
  BookingExpiredError,
  type CreatePaymentInput,
  getPaymentSummary,
  type PaymentAttemptResult,
  type PaymentSummary,
  PaymentTimeoutError,
  submitPayment,
} from "./api";
import {
  initMercadoPago,
  type MercadoPagoField,
  type MercadoPagoIdentificationType,
  type MercadoPagoInstance,
  type MercadoPagoIssuer,
  type MercadoPagoPayerCost,
  type SecureFieldErrorEvent,
  type SecureFieldType,
} from "./mercadopago";
import { cleanCpf, isValidCpf, isValidEmail } from "./validation";

interface CheckoutLocationState {
  sessionId: string;
  seatIds: string[];
}

interface TicketChoice {
  ticketType: TicketType;
  halfPriceDocument: string;
}

interface FieldErrors {
  cardNumber?: string;
  expirationDate?: string;
  securityCode?: string;
  cardholderName?: string;
  identificationNumber?: string;
  email?: string;
  installments?: string;
}

const HALF_PRICE_RATIO = 0.5;

const SECURE_FIELD_ERROR_MESSAGES: Record<SecureFieldType, string> = {
  cardNumber: "Número do cartão inválido.",
  expirationDate: "Data de validade inválida.",
  securityCode: "Código de segurança inválido.",
};

const SECURE_FIELD_LOAD_ERROR_MESSAGE = "Não foi possível carregar o campo do cartão. Recarregue a página.";

// Ids of the containers the SDK mounts each secure iframe into. Shared by the JSX
// and the mount call so they can't drift: the SDK resolves them with
// `document.getElementById`, so they are bare ids, not `#` selectors.
const SECURE_FIELD_CONTAINER_IDS: Record<SecureFieldType, string> = {
  cardNumber: "mp-card-number",
  expirationDate: "mp-expiration-date",
  securityCode: "mp-security-code",
};

const NO_SECURE_FIELD_FAILED: Record<SecureFieldType, boolean> = {
  cardNumber: false,
  expirationDate: false,
  securityCode: false,
};

function secureFieldErrorMessage(fieldType: SecureFieldType, loadFailed: boolean): string {
  return loadFailed ? SECURE_FIELD_LOAD_ERROR_MESSAGE : SECURE_FIELD_ERROR_MESSAGES[fieldType];
}

function unmountSecureField(fieldType: SecureFieldType, field: MercadoPagoField) {
  try {
    field.unmount?.();
  } catch (err) {
    // The SDK throws when the field never mounted (its `error` event already reported why).
    console.warn(`[checkout] Could not unmount secure field "${fieldType}"`, err);
  }
}

function isCheckoutLocationState(state: unknown): state is CheckoutLocationState {
  return (
    typeof state === "object" &&
    state !== null &&
    "sessionId" in state &&
    "seatIds" in state
  );
}

function priceForChoice(basePriceCents: number, choice: TicketChoice): number {
  return choice.ticketType === "half" ? Math.round(basePriceCents * HALF_PRICE_RATIO) : basePriceCents;
}

export function CheckoutPage() {
  const { accessToken } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = isCheckoutLocationState(location.state) ? location.state : null;

  const [seats, setSeats] = useState<SeatMapSeat[] | null>(null);
  const [priceCents, setPriceCents] = useState(0);
  const [choices, setChoices] = useState<Record<string, TicketChoice>>({});
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [bookingInProgress, setBookingInProgress] = useState(false);

  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [mpInstance, setMpInstance] = useState<MercadoPagoInstance | null>(null);
  const [identificationTypes, setIdentificationTypes] = useState<MercadoPagoIdentificationType[]>([
    { id: "CPF", name: "CPF" },
  ]);
  const [identificationType, setIdentificationType] = useState("CPF");
  const [identificationNumber, setIdentificationNumber] = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [email, setEmail] = useState("");

  const [paymentMethod, setPaymentMethod] = useState<{ id: string; name: string } | null>(null);
  const [needsIssuerSelection, setNeedsIssuerSelection] = useState(false);
  const [issuers, setIssuers] = useState<MercadoPagoIssuer[]>([]);
  const [issuerId, setIssuerId] = useState("");
  const [installmentOptions, setInstallmentOptions] = useState<MercadoPagoPayerCost[]>([]);
  const [installments, setInstallments] = useState("");

  const [secureFieldValid, setSecureFieldValid] = useState<Record<SecureFieldType, boolean>>({
    cardNumber: true,
    expirationDate: true,
    securityCode: true,
  });
  const [secureFieldLoadFailed, setSecureFieldLoadFailed] =
    useState<Record<SecureFieldType, boolean>>(NO_SECURE_FIELD_FAILED);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const [error, setError] = useState<string | null>(null);
  const [bookingExpired, setBookingExpired] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<CreatePaymentInput | null>(null);
  const [paymentResult, setPaymentResult] = useState<PaymentAttemptResult | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);

  // Step 1: Load seat map so the user can review seats and pick full/half tickets.
  useEffect(() => {
    if (!state || !accessToken || bookingId) return;
    let cancelled = false;

    getSeatMap(state.sessionId, accessToken)
      .then((seatMap) => {
        if (cancelled) return;
        const selectedSeats = seatMap.seats.filter((seat) => state.seatIds.includes(seat.id));
        setPriceCents(seatMap.priceCents);
        setSeats(selectedSeats);
        setChoices(
          Object.fromEntries(
            selectedSeats.map((seat) => [seat.id, { ticketType: "full", halfPriceDocument: "" }]),
          ),
        );
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          window.location.href = "/login";
          return;
        }
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [state, accessToken, bookingId]);

  // Step 2a: Once a booking exists, load its payment summary and initialize MercadoPago.js.
  useEffect(() => {
    if (!bookingId || !accessToken) return;
    let cancelled = false;

    Promise.all([getPaymentSummary(bookingId, accessToken), initMercadoPago()])
      .then(async ([summary, mp]) => {
        if (cancelled) return;
        setPaymentSummary(summary);
        setMpInstance(mp);

        try {
          const idTypes = await mp.getIdentificationTypes();
          if (!cancelled && idTypes.length > 0) {
            setIdentificationTypes(idTypes);
            const defaultType = idTypes.find((t) => t.id === "CPF")?.id ?? idTypes[0].id;
            setIdentificationType(defaultType);
          }
        } catch {
          // Keep default CPF option if identification types fail to load.
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          window.location.href = "/login";
          return;
        }
        if (err instanceof BookingExpiredError) {
          setBookingExpired(true);
          return;
        }
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [bookingId, accessToken]);

  // The secure field containers are rendered exactly when this is true (see the JSX below).
  const showPaymentForm = Boolean(bookingId && paymentSummary && !paymentResult);

  // Step 2b: Mount secure iframe fields (cardNumber, expirationDate, securityCode) and wire SDK events.
  // Gated on the same condition that renders their containers, so they are in the DOM when mount runs.
  // Each run creates fresh fields and the cleanup unmounts them, which the SDK supports (it only rejects
  // creating a field type that is currently mounted), so React StrictMode's mount/unmount/mount works.
  useEffect(() => {
    if (!mpInstance || !paymentSummary || !showPaymentForm) return;
    let cancelled = false;

    const cardNumberField = mpInstance.fields.create("cardNumber", {
      placeholder: "Número do cartão",
    });
    const expirationDateField = mpInstance.fields.create("expirationDate", {
      placeholder: "MM/AA",
    });
    const securityCodeField = mpInstance.fields.create("securityCode", {
      placeholder: "CVV",
    });

    const bindValidityEvents = (fieldType: SecureFieldType, field: MercadoPagoField) => {
      field.on("validityChange", (event) => {
        if (cancelled) return;
        const hasError =
          event?.isValid === false ||
          (Array.isArray(event?.errorMessages) && event.errorMessages.length > 0);
        setSecureFieldValid((current) => ({ ...current, [fieldType]: !hasError }));
        setFieldErrors((current) => ({
          ...current,
          [fieldType]: hasError ? SECURE_FIELD_ERROR_MESSAGES[fieldType] : undefined,
        }));
      });

      // SDK failures (e.g. mount errors) are not user input errors: surface the real cause in the
      // console and tell the user the field failed to load instead of calling their input invalid.
      field.on("error", (event: SecureFieldErrorEvent) => {
        if (cancelled) return;
        console.error(`[checkout] MercadoPago secure field "${fieldType}" failed`, event);
        setSecureFieldValid((current) => ({ ...current, [fieldType]: false }));
        setSecureFieldLoadFailed((current) => ({ ...current, [fieldType]: true }));
        setFieldErrors((current) => ({
          ...current,
          [fieldType]: SECURE_FIELD_LOAD_ERROR_MESSAGE,
        }));
      });
    };

    // Listeners first, so a mount failure (reported through an async `error` event) is never missed.
    bindValidityEvents("cardNumber", cardNumberField);
    bindValidityEvents("expirationDate", expirationDateField);
    bindValidityEvents("securityCode", securityCodeField);

    cardNumberField.mount(SECURE_FIELD_CONTAINER_IDS.cardNumber);
    expirationDateField.mount(SECURE_FIELD_CONTAINER_IDS.expirationDate);
    securityCodeField.mount(SECURE_FIELD_CONTAINER_IDS.securityCode);

    cardNumberField.on("binChange", async (event) => {
      const bin = event?.bin?.trim() ?? "";
      if (!bin) {
        if (cancelled) return;
        setPaymentMethod(null);
        setNeedsIssuerSelection(false);
        setIssuers([]);
        setIssuerId("");
        setInstallmentOptions([]);
        setInstallments("");
        return;
      }

      try {
        const amount = String(paymentSummary.amountCents / 100);
        const [pmResult, installmentsResult] = await Promise.all([
          mpInstance.getPaymentMethods({ bin }),
          mpInstance.getInstallments({
            amount,
            bin,
            paymentTypeId: "credit_card",
          }),
        ]);
        if (cancelled) return;

        const method = pmResult.results[0];
        if (method) {
          setPaymentMethod({ id: method.id, name: method.name });
          const requiresIssuer = Boolean(method.additional_info_needed?.includes("issuer_id"));
          setNeedsIssuerSelection(requiresIssuer);

          if (requiresIssuer) {
            const issuerList = await mpInstance.getIssuers({
              paymentMethodId: method.id,
              bin,
            });
            if (!cancelled) {
              setIssuers(issuerList);
              setIssuerId(issuerList[0] ? String(issuerList[0].id) : "");
            }
          } else {
            setIssuers([]);
            setIssuerId(method.issuer?.id !== undefined ? String(method.issuer.id) : "");
          }
        } else {
          setPaymentMethod(null);
          setNeedsIssuerSelection(false);
          setIssuers([]);
          setIssuerId("");
        }

        const costs = installmentsResult[0]?.payer_costs ?? [];
        setInstallmentOptions(costs);
        setInstallments("");
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      }
    });

    return () => {
      cancelled = true;
      unmountSecureField("cardNumber", cardNumberField);
      unmountSecureField("expirationDate", expirationDateField);
      unmountSecureField("securityCode", securityCodeField);
    };
  }, [mpInstance, paymentSummary, showPaymentForm]);

  function updateChoice(seatId: string, update: Partial<TicketChoice>) {
    setChoices((current) => ({ ...current, [seatId]: { ...current[seatId], ...update } }));
  }

  const missingDocument = Object.values(choices).some(
    (choice) => choice.ticketType === "half" && choice.halfPriceDocument.trim() === "",
  );

  function confirmCancel() {
    if (state && accessToken) {
      // Best-effort: the hold's TTL frees the seat up anyway even if this call fails.
      releaseAllHolds(state.sessionId, accessToken).catch(() => {});
    }
    navigate("/movies");
  }

  async function handleContinueToPayment() {
    if (!state || !accessToken || missingDocument || bookingId) return;
    setError(null);
    setBookingExpired(false);
    setBookingInProgress(true);
    try {
      const seatPayload = state.seatIds.map((seatId) => {
        const choice = choices[seatId];
        return {
          seatId,
          ticketType: choice.ticketType,
          halfPriceDocument: choice.ticketType === "half" ? choice.halfPriceDocument.trim() : undefined,
        };
      });
      const result = await bookSeats(state.sessionId, seatPayload, accessToken);
      setBookingId(result.bookingId);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
      setError((err as Error).message);
    } finally {
      setBookingInProgress(false);
    }
  }

  function validatePaymentFields(): boolean {
    const nextErrors: FieldErrors = {};

    if (!secureFieldValid.cardNumber) {
      nextErrors.cardNumber = secureFieldErrorMessage("cardNumber", secureFieldLoadFailed.cardNumber);
    }
    if (!secureFieldValid.expirationDate) {
      nextErrors.expirationDate = secureFieldErrorMessage("expirationDate", secureFieldLoadFailed.expirationDate);
    }
    if (!secureFieldValid.securityCode) {
      nextErrors.securityCode = secureFieldErrorMessage("securityCode", secureFieldLoadFailed.securityCode);
    }
    if (cardholderName.trim() === "") {
      nextErrors.cardholderName = "Informe o nome do titular.";
    }
    if (!isValidCpf(identificationNumber)) {
      nextErrors.identificationNumber = "CPF inválido.";
    }
    if (!isValidEmail(email)) {
      nextErrors.email = "Informe um e-mail válido.";
    }
    if (!installments) {
      nextErrors.installments = "Selecione o número de parcelas.";
    }

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function executePaymentAttempt(attemptInput: CreatePaymentInput) {
    if (!bookingId || !accessToken) return;
    setError(null);
    setBookingExpired(false);
    setSubmittingPayment(true);
    try {
      const result = await submitPayment(bookingId, attemptInput, accessToken);
      if (result.status === "approved" || result.status === "in_process" || result.status === "pending" || result.status === "authorized") {
        setPendingRetry(null);
        setPaymentResult(result);
        return;
      }

      // Rejected or cancelled: keep the same bookingId, clear pendingRetry so the
      // next attempt generates a fresh attemptId and card token.
      setPendingRetry(null);
      setError(result.message || "Pagamento recusado. Confira os dados ou use outro cartão.");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        window.location.href = "/login";
        return;
      }
      if (err instanceof BookingExpiredError) {
        setPendingRetry(null);
        setBookingExpired(true);
        return;
      }
      if (err instanceof PaymentTimeoutError) {
        // Provider timeout or network drop: preserve the exact same attemptId and token for idempotent replay.
        setPendingRetry(attemptInput);
        setError(err.message);
        return;
      }
      setPendingRetry(null);
      setError((err as Error).message);
    } finally {
      setSubmittingPayment(false);
    }
  }

  async function handlePaymentSubmit() {
    if (!bookingId || !accessToken || !mpInstance || !paymentSummary) return;

    // Replay the exact same attemptId + token when recovering from a timeout/network drop.
    if (pendingRetry) {
      await executePaymentAttempt(pendingRetry);
      return;
    }

    if (!validatePaymentFields()) {
      return;
    }

    setError(null);
    setSubmittingPayment(true);
    let tokenResult: { id: string };
    try {
      tokenResult = await mpInstance.fields.createCardToken({
        cardholderName: cardholderName.trim(),
        identificationType,
        identificationNumber: cleanCpf(identificationNumber),
      });
    } catch (err) {
      setSubmittingPayment(false);
      setError((err as Error).message || "Não foi possível validar os dados do cartão.");
      return;
    }

    const attemptInput: CreatePaymentInput = {
      attemptId: crypto.randomUUID(),
      token: tokenResult.id,
      paymentMethodId: paymentMethod?.id ?? "",
      issuerId: issuerId || undefined,
      installments: Number(installments),
      payer: {
        email: email.trim(),
        identification: {
          type: identificationType,
          number: cleanCpf(identificationNumber),
        },
      },
    };

    await executePaymentAttempt(attemptInput);
  }

  if (!state) {
    return <Navigate to="/movies" replace />;
  }

  if (paymentResult) {
    const isApproved = paymentResult.status === "approved";
    return (
      <main className="mx-auto max-w-md px-4 py-8 text-center">
        <h1 className="text-2xl font-semibold">
          {isApproved ? "Pagamento aprovado!" : "Pagamento em análise"}
        </h1>
        <p className="mt-2 text-gray-600">
          {isApproved
            ? paymentResult.message || "Seu ingresso foi confirmado. Você recebeu um e-mail com os detalhes da compra."
            : "Pagamento em análise. Você recebe a confirmação por e-mail e o ingresso aparece em Meus ingressos."}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Link to="/tickets" className="text-sm underline">
            Ver meus ingressos
          </Link>
          <Link to="/movies" className="text-sm underline">
            Voltar ao catálogo
          </Link>
        </div>
      </main>
    );
  }

  const step1TotalCents =
    seats?.reduce((sum, seat) => sum + priceForChoice(priceCents, choices[seat.id]), 0) ?? 0;
  const displayTotalCents = paymentSummary ? paymentSummary.amountCents : step1TotalCents;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      {!bookingId && !bookingInProgress && (
        <button
          type="button"
          onClick={() => setShowCancelModal(true)}
          className="mb-4 text-sm text-gray-600 underline"
        >
          ← Voltar
        </button>
      )}
      <h1 className="mb-4 text-2xl font-semibold">
        {bookingId ? "Pagamento com cartão" : "Resumo do pedido"}
      </h1>

      {!bookingId && !seats && !error && <p>Carregando resumo…</p>}
      {bookingId && !paymentSummary && !error && !bookingExpired && <p>Carregando pagamento…</p>}

      {error && (
        <p role="alert" className="mb-4 text-red-600">
          {error}
        </p>
      )}

      {bookingExpired && (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3">
          <p className="mb-2 text-red-700">Sua reserva expirou. Escolha os assentos novamente.</p>
          <Link
            to={`/sessions/${state.sessionId}/seats`}
            className="inline-block rounded bg-gray-900 px-3 py-1.5 text-sm text-white"
          >
            Escolher assentos
          </Link>
        </div>
      )}

      {!bookingId && seats && (
        <>
          <ul className="mb-4 flex flex-col gap-4">
            {seats.map((seat) => {
              const choice = choices[seat.id];
              return (
                <li key={seat.id} className="rounded border border-gray-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      Assento {seat.rowLabel}
                      {seat.seatNumber}
                    </span>
                    <span className="text-sm text-gray-500">
                      R$ {(priceForChoice(priceCents, choice) / 100).toFixed(2)}
                    </span>
                  </div>

                  <div className="mt-2 flex gap-4 text-sm">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={`ticket-type-${seat.id}`}
                        checked={choice.ticketType === "full"}
                        onChange={() => updateChoice(seat.id, { ticketType: "full" })}
                      />
                      Inteira
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={`ticket-type-${seat.id}`}
                        checked={choice.ticketType === "half"}
                        onChange={() => updateChoice(seat.id, { ticketType: "half" })}
                      />
                      Meia
                    </label>
                  </div>

                  {choice.ticketType === "half" && (
                    <label className="mt-2 flex flex-col gap-1">
                      <span className="text-xs text-gray-500">Documento da meia-entrada</span>
                      <input
                        type="text"
                        value={choice.halfPriceDocument}
                        onChange={(event) =>
                          updateChoice(seat.id, { halfPriceDocument: event.target.value })
                        }
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="mb-6 text-lg font-medium">Total: R$ {(displayTotalCents / 100).toFixed(2)}</p>

          <button
            type="button"
            disabled={bookingInProgress || bookingExpired || !seats || missingDocument}
            onClick={handleContinueToPayment}
            className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {bookingInProgress ? "Reservando…" : "Continuar para pagamento"}
          </button>
        </>
      )}

      {showPaymentForm && paymentSummary && (
        <div className="flex flex-col gap-4">
          <div className="rounded border border-gray-200 p-3 text-sm">
            <p className="font-medium">{paymentSummary.description}</p>
            <ul className="mt-2 flex flex-col gap-1 text-gray-600">
              {paymentSummary.seats.map((seat) => (
                <li key={seat.seatId} className="flex justify-between">
                  <span>
                    Assento {seat.label} ({seat.ticketType === "half" ? "Meia" : "Inteira"})
                  </span>
                  <span>R$ {(seat.priceCents / 100).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-base font-semibold text-gray-900">
              Total: R$ {(paymentSummary.amountCents / 100).toFixed(2)}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Número do cartão</span>
            <div
              id={SECURE_FIELD_CONTAINER_IDS.cardNumber}
              data-testid="mp-card-number"
              className="h-10 rounded border border-gray-300 px-2 py-1"
            />
            {paymentMethod && (
              <p className="text-xs text-gray-600">Bandeira: {paymentMethod.name}</p>
            )}
            {fieldErrors.cardNumber && (
              <p className="text-xs text-red-600">{fieldErrors.cardNumber}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Validade</span>
              <div
                id={SECURE_FIELD_CONTAINER_IDS.expirationDate}
                data-testid="mp-expiration-date"
                className="h-10 rounded border border-gray-300 px-2 py-1"
              />
              {fieldErrors.expirationDate && (
                <p className="text-xs text-red-600">{fieldErrors.expirationDate}</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Código de segurança</span>
              <div
                id={SECURE_FIELD_CONTAINER_IDS.securityCode}
                data-testid="mp-security-code"
                className="h-10 rounded border border-gray-300 px-2 py-1"
              />
              {fieldErrors.securityCode && (
                <p className="text-xs text-red-600">{fieldErrors.securityCode}</p>
              )}
            </div>
          </div>

          {needsIssuerSelection && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Banco emissor</span>
              <select
                value={issuerId}
                onChange={(event) => {
                  setPendingRetry(null);
                  setIssuerId(event.target.value);
                }}
                className="rounded border border-gray-300 px-2 py-1.5"
              >
                {issuers.map((issuer) => (
                  <option key={String(issuer.id)} value={String(issuer.id)}>
                    {issuer.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Parcelas</span>
            <select
              value={installments}
              onChange={(event) => {
                setPendingRetry(null);
                setInstallments(event.target.value);
                setFieldErrors((current) => ({ ...current, installments: undefined }));
              }}
              className="rounded border border-gray-300 px-2 py-1.5"
            >
              <option value="">Selecione as parcelas</option>
              {installmentOptions.map((option) => (
                <option key={option.installments} value={String(option.installments)}>
                  {option.recommended_message}
                </option>
              ))}
            </select>
            {fieldErrors.installments && (
              <span className="text-xs text-red-600">{fieldErrors.installments}</span>
            )}
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Nome do titular</span>
            <input
              type="text"
              value={cardholderName}
              onChange={(event) => {
                setPendingRetry(null);
                setCardholderName(event.target.value);
                setFieldErrors((current) => ({ ...current, cardholderName: undefined }));
              }}
              className="rounded border border-gray-300 px-2 py-1.5"
            />
            {fieldErrors.cardholderName && (
              <span className="text-xs text-red-600">{fieldErrors.cardholderName}</span>
            )}
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Tipo de documento</span>
              <select
                value={identificationType}
                onChange={(event) => {
                  setPendingRetry(null);
                  setIdentificationType(event.target.value);
                }}
                className="rounded border border-gray-300 px-2 py-1.5"
              >
                {identificationTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="col-span-2 flex flex-col gap-1 text-sm">
              <span className="font-medium">CPF</span>
              <input
                type="text"
                value={identificationNumber}
                onChange={(event) => {
                  setPendingRetry(null);
                  setIdentificationNumber(event.target.value);
                  setFieldErrors((current) => ({ ...current, identificationNumber: undefined }));
                }}
                className="rounded border border-gray-300 px-2 py-1.5"
              />
              {fieldErrors.identificationNumber && (
                <span className="text-xs text-red-600">{fieldErrors.identificationNumber}</span>
              )}
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">E-mail</span>
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setPendingRetry(null);
                setEmail(event.target.value);
                setFieldErrors((current) => ({ ...current, email: undefined }));
              }}
              className="rounded border border-gray-300 px-2 py-1.5"
            />
            {fieldErrors.email && (
              <span className="text-xs text-red-600">{fieldErrors.email}</span>
            )}
          </label>

          <button
            type="button"
            disabled={submittingPayment || bookingExpired}
            onClick={handlePaymentSubmit}
            className="mt-2 rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {submittingPayment
              ? "Processando…"
              : pendingRetry
                ? "Tentar de novo"
                : "Pagar"}
          </button>
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 px-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded bg-white p-6">
            <p className="mb-4">Deseja mesmo cancelar a reserva?</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCancelModal(false)}
                className="rounded px-3 py-1.5 text-sm text-gray-600"
              >
                Não
              </button>
              <button
                type="button"
                onClick={confirmCancel}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
              >
                Sim, cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
