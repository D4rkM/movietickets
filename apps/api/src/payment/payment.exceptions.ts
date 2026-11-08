import {
  ConflictException,
  GatewayTimeoutException,
  UnprocessableEntityException,
} from "@nestjs/common";

export const PAYMENT_IN_PROGRESS_CODE = "PAYMENT_IN_PROGRESS";
export const ATTEMPT_ID_CONFLICT_CODE = "ATTEMPT_ID_CONFLICT";
export const PAYMENT_REQUEST_INVALID_CODE = "PAYMENT_REQUEST_INVALID";
export const PAYMENT_PROVIDER_TIMEOUT_CODE = "PAYMENT_PROVIDER_TIMEOUT";

export class PaymentInProgressException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: PAYMENT_IN_PROGRESS_CODE,
      message: "Já existe um pagamento em andamento para esta reserva.",
    });
  }
}

export class AttemptIdConflictException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: ATTEMPT_ID_CONFLICT_CODE,
      message: "Este identificador de tentativa já foi utilizado em outra reserva.",
    });
  }
}

export class PaymentRequestInvalidException extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: 422,
      code: PAYMENT_REQUEST_INVALID_CODE,
      message: "Não foi possível processar os dados do pagamento. Confira os dados do cartão e tente novamente.",
    });
  }
}

export class PaymentProviderTimeoutException extends GatewayTimeoutException {
  constructor() {
    super({
      statusCode: 504,
      code: PAYMENT_PROVIDER_TIMEOUT_CODE,
      message: "O provedor de pagamento não respondeu a tempo. Tente novamente.",
    });
  }
}
