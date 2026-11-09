# Sequence: Reserva de assentos (booking)

Fluxo de ponta a ponta hoje: visitante (convidado ou logado) abre o mapa de assentos, segura assentos no Valkey, faz login ao avançar pro pagamento, cria a reserva no checkout e paga. Cobre `SessionSeatsPage`/`CheckoutPage` (Frontend) → `SeatingController`/`BookingController`/`PaymentController` (Backend) → Valkey (Cache) → Postgres (Database).

Detalhes em diagramas próprios:

- convidado segurando assento e transferência no login: [`../public-catalog-login-gate/sequence.md`](../public-catalog-login-gate/sequence.md)
- tentativa de pagamento e webhook: [`../checkout-transparente/sequence.md`](../checkout-transparente/sequence.md)

```mermaid
sequenceDiagram
    actor Cliente
    participant Frontend
    participant Backend
    participant Cache
    participant Database

    Cliente->>Frontend: abre /sessions/:id/seats
    Frontend->>Backend: GET /sessions/:id/seats (token de usuário ou de convidado)
    Backend->>Database: assentos + booking_seats de bookings que travam assento (activeBookingCondition)
    Backend->>Cache: SCAN/MGET seat-hold:{sessionId}:*
    Backend-->>Frontend: mapa (free / held_by_other / held_by_me / booked)
    Frontend->>Backend: WebSocket /seating, join(sessionId)

    Cliente->>Frontend: clica num assento
    Frontend->>Backend: POST /sessions/:id/seats/:seatId/hold
    Backend->>Cache: SET seat-hold:{sessionId}:{seatId} {dono} NX EX 600
    alt já segurado por outro, reservado ou limite de 6
        Backend-->>Frontend: 409
    else livre
        Backend-->>Frontend: 200 { status: "held", expiresInSeconds }
        Backend-->>Frontend: seat:update held (pros outros na room)
    end

    Cliente->>Frontend: clica "Continuar"
    opt convidado
        Frontend->>Frontend: /login (holds transferidos pro usuário, ver diagrama próprio)
    end
    Frontend->>Frontend: navega pra /checkout {sessionId, seatIds}
    Cliente->>Frontend: escolhe inteira/meia por assento (+ documento se meia)
    Frontend->>Backend: POST /sessions/:id/book { seats: [...] }
    Backend->>Database: BEGIN, expira bookings pending vencidos em conflito (lazy)
    Backend->>Database: insert booking (pending, expires_at = now() + 10 min) + booking_seats (unique session_id+seat_id)
    alt assento já reservado (23505)
        Backend->>Database: ROLLBACK
        alt reserva pending do próprio usuário pros mesmos assentos
            Backend-->>Frontend: 409 BOOKING_ALREADY_PENDING { bookingId } (front retoma essa reserva)
        else
            Backend-->>Frontend: 409
        end
    else ok
        Backend->>Database: COMMIT
        Backend->>Cache: DEL holds dos assentos reservados
        Backend-->>Frontend: 201 [{ bookingId, seatId, priceCents, ... }]
    end

    Frontend->>Backend: GET /bookings/:id/payment-summary
    Backend-->>Frontend: valor, assentos, expiresAt
    Note over Frontend,Database: pagamento: ver checkout-transparente/sequence.md
    Backend-->>Frontend: approved → booking confirmed, seat:update booked, e-mail de confirmação
```

## Fora do fluxo feliz

- **Token expirado** (`401` em rota de usuário): front limpa o token e redireciona pra `/login`.
- **Hold expira** (TTL de 600s): o Valkey emite keyspace notification e o `HoldExpiryListener` faz broadcast `released`.
- **Desistência**: "← Voltar" em `SessionSeatsPage`/`CheckoutPage` abre confirmação; confirmar chama `DELETE /sessions/:id/holds` (solta todos os holds do dono na sessão) e volta pro catálogo. Desmarcar um assento chama `DELETE /sessions/:id/seats/:seatId/hold`.
- **Reserva expira sem pagamento**: booking `pending` passado do `expires_at` sem pagamento `pending`/`in_process` vira `expired`, os `booking_seats` são apagados e sai broadcast `released` — pelo `PendingBookingSweeper` (a cada 60s) ou de forma lazy na próxima reserva em conflito. Pagamento depois disso responde `409 BOOKING_EXPIRED` e o checkout mostra o aviso com volta ao mapa. Spec: `docs/flows/pending-booking-expiry/spec.md`.
- **Cancelamento pelo cliente** (`POST /bookings/:id/cancel`, em "Meus ingressos"): booking `cancelled`, assentos liberados com broadcast `released`.

## Referências

- `apps/web/src/features/seating/SessionSeatsPage.tsx`, `apps/web/src/features/checkout/CheckoutPage.tsx`
- `apps/api/src/seating/seating.controller.ts`, `apps/api/src/seating/seating.service.ts`, `apps/api/src/seating/hold-expiry.listener.ts`
- `apps/api/src/booking/booking.controller.ts`, `apps/api/src/booking/booking.service.ts`, `apps/api/src/booking/booking-lock.ts`, `apps/api/src/booking/pending-booking.sweeper.ts`
- `apps/api/src/payment/payment.controller.ts`
