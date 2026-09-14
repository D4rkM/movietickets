# Sequence: Reserva de assentos (booking)

Fluxo real de ponta a ponta hoje: cliente já autenticado escolhe assentos numa sessão, revisa no checkout e "paga" (mock). Cobre `SessionSeatsPage`/`CheckoutPage` (Frontend) → `BookingController`/`SeatingController`/`BookingService` (Backend) → Valkey (Cache) → Postgres (Database).

Sem hold via Valkey ainda — o `SeatingService` já lê chaves `seat-hold:*` no Cache pra decidir `held_by_other`/`held_by_me` (ver passo no seat map), mas nada escreve essas chaves hoje, então o Cache sempre volta vazio e esse ramo nunca dispara na prática (próxima story "Segurar assento").

```mermaid
sequenceDiagram
    actor Cliente
    participant Frontend
    participant Backend
    participant Cache
    participant Database

    Cliente->>Frontend: abre /sessions/:id/seats
    Frontend->>Backend: GET /sessions/:id/seats (Bearer token)
    Backend->>Database: query sessão + sala + assentos + bookings confirmados
    Database-->>Backend: assentos com status (free/booked)
    Backend->>Cache: SCAN/MGET seat-hold:{sessionId}:*
    Cache-->>Backend: hoje sempre vazio (nada escreve hold ainda)
    Backend-->>Frontend: mapa de assentos
    Cliente->>Frontend: seleciona 1+ assentos
    Cliente->>Frontend: clica "Pagar (N assentos)"
    Frontend->>Frontend: navega pra /checkout {sessionId, seatIds}

    Frontend->>Backend: GET /sessions/:id/seats (recarrega pra pegar preço + dados atuais)
    Backend-->>Frontend: mapa de assentos
    Cliente->>Frontend: escolhe inteira/meia por assento (+ documento se meia)
    Cliente->>Frontend: clica "Pagar (mock)"

    Frontend->>Backend: POST /sessions/:id/book { seats: [{seatId, ticketType, halfPriceDocument?}] }
    Backend->>Database: BEGIN transaction
    Backend->>Database: insert booking (status=pending)
    loop cada assento
        Backend->>Database: insert booking_seat (unique session_id+seat_id)
    end
    alt algum assento já reservado (unique violation, code 23505)
        Database-->>Backend: erro
        Backend->>Database: ROLLBACK
        Backend-->>Frontend: 409 Conflict
        Frontend-->>Cliente: mostra erro, nada foi gravado
    else todos os assentos livres
        Backend->>Database: COMMIT
        Backend-->>Frontend: 201 + array [{bookingId, seatId, priceCents}, ...] (mesmo bookingId em todos)

        Frontend->>Backend: POST /bookings/:bookingId/confirm
        Backend->>Database: update booking set status=confirmed
        Database-->>Backend: ok
        Backend-->>Frontend: 200
        Frontend-->>Cliente: "Ingresso confirmado!"
    end
```

## Fora do fluxo feliz

- **Token expirado** (`401` em qualquer chamada): front limpa o token e redireciona pra `/login`.
- **Desistência**: botão "← Voltar" tanto em `SessionSeatsPage` quanto `CheckoutPage` navega de volta sem chamar `/book` — como não há hold hoje, não há nada pra limpar no banco/Valkey. Quando o hold TTL existir, esse voltar vai precisar liberar a chave.

## Referências

- `apps/web/src/features/seating/SessionSeatsPage.tsx`, `apps/web/src/features/checkout/CheckoutPage.tsx`
- `apps/api/src/seating/seating.controller.ts`, `apps/api/src/seating/seating.service.ts`
- `apps/api/src/booking/booking.controller.ts`, `apps/api/src/booking/booking-confirmation.controller.ts`, `apps/api/src/booking/booking.service.ts`
