# Classes: Estorno de pagamento

Módulos `RefundModule` (`apps/api/src/refund/`) e a parte de estorno do `AdminModule` (`apps/api/src/admin/refunds/`). Spec: [`spec.md`](./spec.md); fluxos em [`sequence.md`](./sequence.md).

```mermaid
classDiagram
    direction LR

    class RefundController {
        <<controller>>
        POST ID/cancel
    }
    class AdminRefundsController {
        <<controller>>
        GET refunds/review
        POST bookings/ID/refund
    }
    class JwtAuthGuard {
        <<guard>>
    }
    class RolesGuard {
        <<guard>>
        Roles admin
    }
    class RefundService {
        <<service>>
        cancelWithRefund()
        requestAdminRefund()
        applyRefundStatus()
        applyRefundedPayment()
    }
    class RefundReviewQueriesService {
        <<service>>
        fila needs_refund_review
    }
    class RefundStatus {
        <<helpers>>
        decideRefundTransition()
        toCustomerRefundStatus()
    }
    class RefundHelpers {
        <<helpers>>
        buildRefundRequest()
        classifyRefundProviderError()
    }
    class BookingService {
        <<service>>
        cancelConfirmedBooking()
    }
    class NotificationService {
        <<service>>
    }
    class REFUND_CLIENT {
        <<token>>
        mercadopago PaymentRefund
    }
    class PAYMENT_CLIENT {
        <<token>>
        mercadopago Payment
    }
    class PaymentService {
        <<service>>
    }
    class DRIZZLE {
        <<token>>
    }

    RefundController ..> JwtAuthGuard
    AdminRefundsController ..> JwtAuthGuard
    AdminRefundsController ..> RolesGuard
    RefundController --> RefundService
    AdminRefundsController --> RefundService
    AdminRefundsController --> RefundReviewQueriesService
    RefundReviewQueriesService --> DRIZZLE
    RefundService --> DRIZZLE : refunds, payment_events, bookings
    RefundService --> REFUND_CLIENT
    RefundService --> PAYMENT_CLIENT
    RefundService --> BookingService : cancela na mesma transacao
    RefundService --> NotificationService
    RefundService ..> RefundStatus
    RefundService ..> RefundHelpers
    PaymentService --> RefundService : webhook de refund e payment refunded
```

## Notas

- `RefundModule` importa `AuthTokenModule`, `BookingModule`, `NotificationModule` e `MercadoPagoModule`; exporta `RefundService`. `AdminModule` importa `RefundModule`.
- `RefundService` é o ponto único que muda `refunds`: usado pelo cliente (cancelar ingresso), pelo admin (fila de revisão) e pelo webhook (via `PaymentService`).
- A barreira contra estorno duplo é o índice único parcial `refunds_active_per_payment_uq` (ver [`../../schema.md`](../../schema.md)).
