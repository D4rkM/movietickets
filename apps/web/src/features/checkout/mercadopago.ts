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
  mount(container: string | HTMLElement): MercadoPagoField | void;
  unmount?(): void;
  on(event: "binChange", handler: (event: BinChangeEvent) => void): MercadoPagoField | void;
  on(event: "validityChange", handler: (event: ValidityChangeEvent) => void): MercadoPagoField | void;
  on(event: "error", handler: (event: unknown) => void): MercadoPagoField | void;
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
