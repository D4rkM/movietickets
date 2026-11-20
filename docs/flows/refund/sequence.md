# Sequence: Estorno de pagamento

Cancelamento com estorno pelo cliente, estorno pela fila de revisão do admin e conclusão pelo webhook. Spec: [`spec.md`](./spec.md). Os diagramas usam os padrões recomendados das decisões em aberto (prazo de 2h, reserva continua `confirmed` se o estorno falha).

## 1. Cliente cancela ingresso pago

```mermaid
sequenceDiagram
    actor Cliente
    participant Frontend
    participant Backend
    participant Database
    participant MP as Mercado Pago API
    participant WS as SeatingGateway (WebSocket)

    Cliente->>Frontend: "Cancelar" em Meus ingressos
    Frontend-->>Cliente: diálogo: valor estornado integralmente + prazo (cancellableUntil)
    Cliente->>Frontend: "Sim, cancelar"
    Frontend->>Backend: POST /bookings/:id/cancel

    Backend->>Database: tx1: SELECT booking FOR UPDATE
    alt outro usuário / inexistente
        Backend-->>Frontend: 404
    else já cancelled
        Backend-->>Frontend: 200 estado atual (replay, sem MP)
    else pending / expired
        Backend-->>Frontend: 409 BOOKING_NOT_CANCELLABLE
    else starts_at - 2h <= now() (relógio do banco)
        Backend-->>Frontend: 409 CANCELLATION_DEADLINE_PASSED
    else sem pagamento approved (mock/seed)
        Backend->>Database: booking cancelled + snapshot de assentos + DELETE booking_seats + booking_cancelled, COMMIT
        Backend->>WS: seat:update released (por assento)
        Backend-->>Frontend: 200 { status: cancelled, refund: null }
    else estorno requested recente ou in_process
        Backend-->>Frontend: 409 REFUND_IN_PROGRESS
    else ok
        Backend->>Database: insert refunds (requested, id = chave) + refund_requested, COMMIT (booking continua confirmed)
        Backend->>MP: POST /v1/payments/{external_payment_id}/refunds (sem amount = total, X-Idempotency-Key = refunds.id)
        alt approved / in_process
            Backend->>Database: tx2: SELECT refunds FOR UPDATE, atualiza status + external_refund_id + refund_response
            Backend->>Database: booking cancelled + snapshot + DELETE booking_seats + booking_cancelled (+ refund_confirmed se approved), COMMIT
            Backend->>WS: seat:update released (por assento)
            Backend->>Backend: e-mail de estorno solicitado (best-effort)
            Backend-->>Frontend: 200 { status: cancelled, refund: { status: completed | pending } }
        else rejected
            Backend->>Database: refunds rejected + refund_response (booking continua confirmed)
            Backend-->>Frontend: 422 REFUND_REJECTED
        else MP 4xx
            Backend->>Database: refunds failed + error_code + refund_request_failed (booking continua confirmed)
            Backend-->>Frontend: 422 REFUND_REQUEST_INVALID
        else MP 409 (mesma chave processando)
            Backend-->>Frontend: 409 REFUND_IN_PROGRESS
        else sem resposta
            Backend-->>Frontend: 504 REFUND_PROVIDER_TIMEOUT (refunds continua requested)
            Note over Frontend,Backend: "Tentar de novo" depois de 2 min re-tenta com a MESMA chave
        end
    end
```

## 2. Admin estorna reserva da fila de revisão

```mermaid
sequenceDiagram
    actor Admin
    participant Frontend
    participant Backend
    participant Database
    participant MP as Mercado Pago API

    Admin->>Frontend: abre /admin/refunds
    Frontend->>Backend: GET /admin/refunds/review (JwtAuthGuard + RolesGuard admin)
    Backend->>Database: bookings com needs_refund_review = true OU refunds requested parado > 2 min
    Backend-->>Frontend: fila (cliente, sessão, valor, motivo, último estorno)

    Admin->>Frontend: "Estornar" + confirma
    Frontend->>Backend: POST /admin/bookings/:id/refund
    Backend->>Database: tx1: SELECT booking FOR UPDATE
    alt fora da fila
        Backend-->>Frontend: 409 REFUND_NOT_ALLOWED
    else estorno in_process
        Backend->>MP: GET /v1/payments/{id} (refunds[])
        Backend->>Database: applyRefundStatus (reconcilia)
        Backend-->>Frontend: 200 estado atual
    else sem estorno ativo, ou requested parado
        Backend->>Database: insert refunds (requested, reason expired_booking_review, requested_by = admin) + refund_requested (source admin), COMMIT
        Note over Backend,Database: requested parado reaproveita a linha e a mesma chave
        Backend->>MP: POST /v1/payments/{id}/refunds (X-Idempotency-Key = refunds.id)
        alt approved
            Backend->>Database: refunds approved + refund_response + refund_confirmed, needs_refund_review = false (booking continua expired)
            Backend-->>Frontend: 200 (sai da fila)
        else in_process
            Backend->>Database: refunds in_process + refund_response
            Backend-->>Frontend: 200 (fica na fila como "em andamento")
        else 4xx / rejected / sem resposta
            Backend-->>Frontend: 422 / 504 (mesmos códigos do cliente)
        end
    end
```

## 3. Webhook de pagamento estornado

```mermaid
sequenceDiagram
    participant MP as Mercado Pago API
    participant Backend
    participant Database
    participant WS as SeatingGateway (WebSocket)

    MP->>Backend: POST /payments/webhook (id do pagamento)
    Backend->>MP: GET /v1/payments/{id} (status nunca vem do corpo da notificação)
    Backend->>Database: tx: atualiza tentativa em payments (approved → refunded permitido) + webhook_received
    alt status refunded
        loop cada item de payment.refunds[]
            Backend->>Database: acha refunds por external_refund_id, senão linha ativa do mesmo payment_id
            alt achou
                Backend->>Database: SELECT refunds FOR UPDATE + applyRefundStatus (mesmo status → ignora)
                opt chegou em approved
                    Backend->>Database: refund_confirmed, needs_refund_review = false
                end
                opt booking ainda confirmed (resposta síncrona perdida)
                    Backend->>Database: booking cancelled + snapshot + DELETE booking_seats + booking_cancelled
                end
            else nenhuma linha (estorno pelo painel do MP)
                Backend->>Database: insert refunds (reason external, approved) + warn
                opt booking confirmed
                    Backend->>Database: booking cancelled + snapshot + DELETE booking_seats
                end
            end
        end
    else approved com refunds[i] rejected
        Backend->>Database: refunds rejected + needs_refund_review = true + warn
    else charged_back / in_mediation
        Backend->>Backend: só warn (reserva sem mudança)
    end
    Backend->>Database: COMMIT
    opt assentos liberados
        Backend->>WS: seat:update released (por assento, pós-commit)
    end
    Backend-->>MP: 200
```

## Referências

- `apps/api/src/booking/booking-confirmation.controller.ts` (`POST /bookings/:id/cancel`, sai pro `RefundModule`)
- `apps/api/src/payment/payment.service.ts` (`handleWebhook`, `applyPaymentStatus`)
- `apps/api/src/payment/mercadopago.providers.ts` (`PAYMENT_CLIENT`; `REFUND_CLIENT` novo)
- `apps/web/src/features/tickets/TicketsPage.tsx`, `apps/web/src/features/admin/`
