# Classes: Pagamento (Checkout Transparente) e MercadoPagoModule

Módulos `PaymentModule` (`apps/api/src/payment/`) e `MercadoPagoModule` (`apps/api/src/mercadopago/`). Cada tentativa vira uma linha em `payments` e eventos append-only em `payment_events`. Spec: [`spec.md`](./spec.md); fluxo em [`sequence.md`](./sequence.md).

```mermaid
classDiagram
    direction LR

    class PaymentController {
        <<controller>>
        GET bookings/ID/payment-summary
        POST bookings/ID/payments
        POST payments/webhook
    }
    class JwtAuthGuard {
        <<guard>>
    }
    class PaymentService {
        <<service>>
        getPaymentSummary()
        createPayment()
        handleWebhook()
        applyPaymentStatus()
    }
    class PaymentHelpers {
        <<helpers>>
        buildPaymentRequest()
        canTransitionPaymentStatus()
        buildPaymentEventPayload()
    }
    class BookingService {
        <<service>>
        confirmPaidBooking()
    }
    class RefundService {
        <<service>>
        applyRefundedPayment()
    }
    class MercadoPagoModule {
        <<module>>
        exporta PAYMENT_CLIENT e REFUND_CLIENT
    }
    class PAYMENT_CLIENT {
        <<token>>
        mercadopago Payment
    }
    class REFUND_CLIENT {
        <<token>>
        mercadopago PaymentRefund
    }
    class MercadoPagoProviders {
        <<providers>>
        useFactory com MERCADOPAGO_ACCESS_TOKEN
    }
    class DRIZZLE {
        <<token>>
    }

    PaymentController ..> JwtAuthGuard : summary e payments
    PaymentController --> PaymentService
    PaymentService --> DRIZZLE : payments, payment_events
    PaymentService --> PAYMENT_CLIENT : Inject
    PaymentService --> BookingService : confirma booking aprovado
    PaymentService --> RefundService : pagamento refunded no webhook
    PaymentService ..> PaymentHelpers
    MercadoPagoModule *-- MercadoPagoProviders
    MercadoPagoProviders ..> PAYMENT_CLIENT : provide
    MercadoPagoProviders ..> REFUND_CLIENT : provide
```

## Notas

- `PaymentModule` importa `AuthModule`, `BookingModule`, `MercadoPagoModule` e `RefundModule`.
- `MercadoPagoModule` existe pra `PaymentModule` e `RefundModule` compartilharem os clientes do SDK sem um importar o outro (`RefundModule` não importa `PaymentModule`).
- `POST /payments/webhook` é público; o webhook nunca confia no corpo, ele busca o pagamento no Mercado Pago pelo id.
