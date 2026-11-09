import { loadMercadoPago } from "@mercadopago/sdk-js";

export type SecureFieldType = "cardNumber" | "expirationDate" | "securityCode";

export interface BinChangeEvent {
  bin?: string | null;
}

export interface ValidityChangeEvent {
  errorMessages?: Array<{ message?: string; cause?: string }>;
  isValid?: boolean;
}

export interface MercadoPagoField {
  /**
   * Mounts the secure iframe inside the element with this id. The real SDK
   * resolves it with `document.getElementById`, so it takes a bare id (no `#`
   * selector, no HTMLElement). A missing container does not throw: the SDK logs
   * a warning and emits an async `error` event with a "Container not found" message.
   */
  mount(containerId: string): MercadoPagoField | void;
  /** Throws if the field is not currently mounted (e.g. its mount failed). */
  unmount?(): void;
  on(event: "binChange", handler: (event: BinChangeEvent) => void): MercadoPagoField | void;
  on(event: "validityChange", handler: (event: ValidityChangeEvent) => void): MercadoPagoField | void;
  on(event: "error", handler: (event: SecureFieldErrorEvent) => void): MercadoPagoField | void;
}

/** Payload of the SDK `error` event, e.g. `{ field: "cardNumber", error: "MercadoPago.js - Error when mounting field ...: Container not found" }`. */
export interface SecureFieldErrorEvent {
  field?: string;
  error?: string;
}

export interface MercadoPagoPaymentMethod {
  id: string;
  name: string;
  additional_info_needed?: string[];
  issuer?: { id: string | number; name?: string };
}

export interface MercadoPagoIssuer {
  id: string | number;
  name: string;
}

export interface MercadoPagoPayerCost {
  installments: number;
  recommended_message: string;
}

export interface MercadoPagoInstallmentResult {
  payer_costs: MercadoPagoPayerCost[];
}

export interface MercadoPagoIdentificationType {
  id: string;
  name: string;
}

export interface MercadoPagoInstance {
  fields: {
    create(type: SecureFieldType, options?: { placeholder?: string }): MercadoPagoField;
    createCardToken(cardholderData: {
      cardholderName: string;
      identificationType: string;
      identificationNumber: string;
    }): Promise<{ id: string }>;
  };
  getPaymentMethods(params: { bin: string }): Promise<{ results: MercadoPagoPaymentMethod[] }>;
  getIssuers(params: { paymentMethodId: string; bin: string }): Promise<MercadoPagoIssuer[]>;
  getInstallments(params: {
    amount: string;
    bin: string;
    paymentTypeId: "credit_card";
  }): Promise<MercadoPagoInstallmentResult[]>;
  getIdentificationTypes(): Promise<MercadoPagoIdentificationType[]>;
}

declare global {
  interface Window {
    MercadoPago?: new (
      publicKey: string,
      options?: { locale?: string },
    ) => MercadoPagoInstance;
  }
}

/**
 * Loads the official MercadoPago.js v2 script and returns an initialized
 * Core Methods client configured for pt-BR.
 */
export async function initMercadoPago(): Promise<MercadoPagoInstance> {
  await loadMercadoPago();
  if (!window.MercadoPago) {
    throw new Error("Não foi possível carregar o SDK do Mercado Pago.");
  }
  return new window.MercadoPago(import.meta.env.VITE_MP_PUBLIC_KEY ?? "", {
    locale: "pt-BR",
  });
}
