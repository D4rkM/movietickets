# Sequence: Tentativa de pagamento (Checkout Transparente) e webhook

Uma tentativa de pagamento com cartão numa reserva `pending`, e a notificação posterior do Mercado Pago. Spec: [`spec.md`](./spec.md).

```mermaid
sequenceDiagram
    actor Cliente
    participant Frontend
    participant MPSDK as SDK JS Mercado Pago
    participant Backend
    participant Database
    participant MP as Mercado Pago API

    Cliente->>Frontend: preenche campos seguros + nome, CPF, e-mail, parcelas
    Frontend->>MPSDK: createCardToken(...)
    MPSDK-->>Frontend: token (cartão nunca passa pela nossa API)
    Frontend->>Backend: POST /bookings/:id/payments { attemptId (uuid novo), token, paymentMethodId, issuerId, installments, payer }

    Backend->>Database: tx1: SELECT booking FOR UPDATE
    alt attemptId já usado com resposta final
        Backend-->>Frontend: mesmo resultado gravado (sem chamar o MP)
    else reserva expirada / não pending / outra tentativa em andamento
        Backend-->>Frontend: 409 BOOKING_EXPIRED / BOOKING_NOT_PENDING / PAYMENT_IN_PROGRESS
    else ok
        Backend->>Database: insert payments (id = attemptId, status created) + payment_events attempt_created, COMMIT
        Backend->>MP: Payment.create (valor = soma de booking_seats, X-Idempotency-Key = attemptId, external_reference = bookingId, notification_url)
        alt MP 4xx
            Backend->>Database: tentativa request_failed + mp_request_failed
            Backend-->>Frontend: 422 PAYMENT_REQUEST_INVALID
        else sem resposta
            Backend-->>Frontend: 504 PAYMENT_PROVIDER_TIMEOUT (reenviar mesmo attemptId é seguro)
        else resposta
            Backend->>Database: tx2: atualiza tentativa + mp_response
            opt approved
                Backend->>Database: booking confirmed + booking_confirmed
            end
            Backend-->>Frontend: { status, statusDetail, message, bookingStatus }
            opt approved
                Backend-->>Frontend: seat:update booked (WebSocket) + e-mail de confirmação (pós-commit)
            end
        end
    end
    Note over Frontend: rejected → reserva continua pending, cliente tenta de novo com attemptId e token novos até o expires_at

    MP->>Backend: POST /payments/webhook (id do pagamento)
    Backend->>MP: GET pagamento (status nunca vem do corpo da notificação)
    Backend->>Database: acha tentativa por external_payment_id (ou metadata.attempt_id), atualiza status sem regredir approved
    Backend->>Database: payment_events webhook_received
    opt approved e booking ainda pending
        Backend->>Database: booking confirmed (idempotente) + booking_confirmed
    end
    opt approved e booking expired
        Backend->>Database: needs_refund_review = true (estorno manual)
    end
    Backend-->>MP: 200
```

## Referências

- `apps/web/src/features/checkout/CheckoutPage.tsx`, `apps/web/src/features/checkout/api.ts`, `apps/web/src/features/checkout/mercadopago.ts`
- `apps/api/src/payment/payment.controller.ts`, `apps/api/src/payment/payment.service.ts`, `apps/api/src/payment/payment.helpers.ts`
- `apps/api/src/booking/booking.service.ts` (`confirmPaidBooking`)
