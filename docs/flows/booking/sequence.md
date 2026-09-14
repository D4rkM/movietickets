# Sequence: Reserva de assentos (booking)

Fluxo real de ponta a ponta hoje: cliente já autenticado escolhe assentos numa sessão, revisa no checkout e "paga" (mock). Cobre `SessionSeatsPage` → `CheckoutPage` → `BookingController` → `BookingService` → Postgres.

Sem hold via Valkey ainda — o `SeatingService` lê chaves `seat-hold:*` pra decidir `held_by_other`/`held_by_me`, mas nada escreve essas chaves hoje, então esse ramo nunca dispara na prática (ver [[valkey-not-writing]] / próxima story "Segurar assento").

```mermaid
sequenceDiagram
    actor User as Cliente
    participant Seats as SessionSeatsPage (front)
    participant Checkout as CheckoutPage (front)
    participant API as BookingController / SeatingController
    participant Svc as BookingService
    participant DB as Postgres

    User->>Seats: abre /sessions/:id/seats
    Seats->>API: GET /sessions/:id/seats (Bearer token)
    API->>DB: query sessão + sala + assentos + bookings confirmados
    DB-->>API: assentos com status (free/booked)
    API-->>Seats: mapa de assentos
    User->>Seats: seleciona 1+ assentos
    User->>Seats: clica "Pagar (N assentos)"
    Seats->>Checkout: navigate /checkout {sessionId, seatIds}

    Checkout->>API: GET /sessions/:id/seats (recarrega pra pegar preço + dados atuais)
    API-->>Checkout: mapa de assentos
    User->>Checkout: escolhe inteira/meia por assento (+ documento se meia)
    User->>Checkout: clica "Pagar (mock)"

    Checkout->>API: POST /sessions/:id/book { seats: [{seatId, ticketType, halfPriceDocument?}] }
    API->>Svc: createBookingForSeats(sessionId, seats, userId)
    Svc->>DB: BEGIN transaction
    Svc->>DB: insert booking (status=pending)
    loop cada assento
        Svc->>DB: insert booking_seat (unique session_id+seat_id)
    end
    alt algum assento já reservado (unique violation, code 23505)
        DB-->>Svc: erro
        Svc->>DB: ROLLBACK
        Svc-->>API: 409 Conflict
        API-->>Checkout: 409
        Checkout-->>User: mostra erro, nada foi gravado
    else todos os assentos livres
        Svc->>DB: COMMIT
        Svc-->>API: [{bookingId, seatId, priceCents}, ...]
        API-->>Checkout: 201 + array (mesmo bookingId em todos)

        Checkout->>API: POST /bookings/:bookingId/confirm
        API->>Svc: confirmBooking(bookingId, userId)
        Svc->>DB: update booking set status=confirmed
        DB-->>Svc: ok
        Svc-->>API: confirmado
        API-->>Checkout: 200
        Checkout-->>User: "Ingresso confirmado!"
    end
```

## Fora do fluxo feliz

- **Token expirado** (`401` em qualquer chamada): front limpa o token e redireciona pra `/login`.
- **Desistência**: botão "← Voltar" tanto em `SessionSeatsPage` quanto `CheckoutPage` navega de volta sem chamar `/book` — como não há hold hoje, não há nada pra limpar no banco/Valkey. Quando o hold TTL existir, esse voltar vai precisar liberar a chave.

## Referências

- `apps/web/src/features/seating/SessionSeatsPage.tsx`, `apps/web/src/features/checkout/CheckoutPage.tsx`
- `apps/api/src/seating/seating.controller.ts`, `apps/api/src/seating/seating.service.ts`
- `apps/api/src/booking/booking.controller.ts`, `apps/api/src/booking/booking-confirmation.controller.ts`, `apps/api/src/booking/booking.service.ts`
