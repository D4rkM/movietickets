import {
  ConflictException,
  GatewayTimeoutException,
  UnprocessableEntityException,
} from "@nestjs/common";

export const BOOKING_NOT_CANCELLABLE_CODE = "BOOKING_NOT_CANCELLABLE";
export const CANCELLATION_DEADLINE_PASSED_CODE = "CANCELLATION_DEADLINE_PASSED";
export const REFUND_IN_PROGRESS_CODE = "REFUND_IN_PROGRESS";
export const REFUND_NOT_ALLOWED_CODE = "REFUND_NOT_ALLOWED";
export const REFUND_REQUEST_INVALID_CODE = "REFUND_REQUEST_INVALID";
export const REFUND_REJECTED_CODE = "REFUND_REJECTED";
export const REFUND_PROVIDER_TIMEOUT_CODE = "REFUND_PROVIDER_TIMEOUT";

export class BookingNotCancellableException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: BOOKING_NOT_CANCELLABLE_CODE,
      message: "Só é possível cancelar ingressos confirmados.",
    });
  }
}

export class CancellationDeadlinePassedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: CANCELLATION_DEADLINE_PASSED_CODE,
      message: "O cancelamento só é permitido até 2 horas antes do início da sessão.",
    });
  }
}

export class RefundInProgressException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: REFUND_IN_PROGRESS_CODE,
      message: "Já existe um estorno em andamento para este ingresso.",
    });
  }
}

export class RefundNotAllowedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: REFUND_NOT_ALLOWED_CODE,
      message: "Esta reserva não tem estorno pendente de revisão.",
    });
  }
}

export class RefundRequestInvalidException extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: 422,
      code: REFUND_REQUEST_INVALID_CODE,
      message: "Não foi possível solicitar o estorno agora. Seu ingresso continua válido.",
    });
  }
}

export class RefundRejectedException extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: 422,
      code: REFUND_REJECTED_CODE,
      message: "O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido.",
    });
  }
}

export class RefundProviderTimeoutException extends GatewayTimeoutException {
  constructor() {
    super({
      statusCode: 504,
      code: REFUND_PROVIDER_TIMEOUT_CODE,
      message: "O provedor de pagamento não respondeu a tempo. Tente novamente.",
    });
  }
}
