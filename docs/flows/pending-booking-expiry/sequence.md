# Sequence: Expiração de reserva pendente

Como uma reserva `pending` deixa de travar assentos: o `PendingBookingSweeper` (a cada 60s), a expiração preguiçosa (lazy) numa nova reserva em conflito, a regra única de "ainda trava assento", o pagamento aprovado numa reserva já expirada (vai pra revisão de estorno) e o alerta de pagamento parado há mais de 24h. Spec: [`spec.md`](./spec.md). O estorno em si está em [`../refund/sequence.md`](../refund/sequence.md) e a criação da reserva em [`../booking/sequence.md`](../booking/sequence.md).

Constantes e condições SQL em `apps/api/src/booking/booking-lock.ts`: prazo de 10 min (`PENDING_BOOKING_TTL_MINUTES`), pagamento em andamento = `payments.status` em `pending`/`in_process`, alerta após 24h (`STALE_PAYMENT_ALERT_HOURS`). Todas as comparações de tempo usam o relógio do banco (`now()`), nunca o da instância da API.

## 1. Regra de trava (`activeBookingCondition`)

Uma reserva trava assentos quando é `confirmed`, ou `pending` e (ainda dentro do `expires_at` **ou** com pagamento em andamento). É a mesma regra do mapa de assentos, do hold, da criação de reserva e do sweeper.

```mermaid
flowchart TD
    A["Reserva"] --> B{"status"}
    B -- confirmed --> L["TRAVA assentos"]
    B -- "cancelled / expired" --> F["não trava (booking_seats já apagados)"]
    B -- pending --> C{"expires_at > now()?"}
    C -- sim --> L
    C -- não --> D{"payments pending ou in_process?"}
    D -- sim --> L
    D -- não --> E["EXPIRÁVEL (expirableBookingCondition): destrava na leitura, o sweeper/lazy muda pra expired"]
```

## 2. Sweeper (a cada 60s)

`PendingBookingSweeper.handleInterval` (`@Interval(60_000)`). Só limpeza e UX: mapa, holds e criação de reserva já estão corretos sem ele, pela checagem lazy. Seguro com várias instâncias da API: `FOR UPDATE SKIP LOCKED` mais o `UPDATE ... WHERE status = 'pending'` expiram cada reserva uma única vez, e só quem expirou faz o broadcast.

```mermaid
sequenceDiagram
    participant Timer as Interval 60s
    participant Sweeper as PendingBookingSweeper
    participant Database
    participant WS as SeatingGateway (WebSocket)

    Timer->>Sweeper: handleInterval()
    alt tick anterior ainda rodando nesta instância
        Sweeper->>Sweeper: pula (log debug)
    else
        loop lotes de até 100 até vir lote incompleto
            Sweeper->>Database: BEGIN
            Sweeper->>Database: SELECT id FROM bookings WHERE expirableBookingCondition ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
            Sweeper->>Database: UPDATE bookings SET status = expired WHERE id IN (...) AND status = pending RETURNING id, session_id
            Sweeper->>Database: DELETE booking_seats WHERE booking_id IN (...) RETURNING booking_id, seat_id
            Sweeper->>Database: COMMIT
            loop cada assento liberado (pós-commit)
                Sweeper->>WS: seat:update { seatId, status: released }
            end
            Note over Sweeper: log info "Pending booking expired (sweeper)" por reserva
        end
        Sweeper->>Database: UPDATE bookings SET stale_payment_alerted_at = now() WHERE stalePaymentAlertCondition RETURNING id
        Note over Sweeper,Database: ver diagrama 4 (alerta de pagamento parado)
    end
    Note over Sweeper: erro no tick é logado e engolido, nunca derruba a API
```

## 3. Expiração lazy e pagamento depois do prazo

A reserva nova que conflita com uma `pending` vencida (sem pagamento em andamento) expira a velha na própria transação. Já o pagamento aprovado depois da expiração **não ressuscita** a reserva: o assento pode ser de outra pessoa a essa altura, então a reserva é marcada pra revisão de estorno.

```mermaid
sequenceDiagram
    actor Cliente
    participant Frontend
    participant Backend
    participant Database
    participant MP as Mercado Pago API
    participant WS as SeatingGateway (WebSocket)

    rect rgb(240, 240, 240)
    Note over Cliente,WS: A. Lazy: nova reserva em assento de pending vencida
    Cliente->>Frontend: "Pagar" em outro checkout
    Frontend->>Backend: POST /sessions/:id/book { seats }
    Backend->>Database: BEGIN
    Backend->>Database: UPDATE bookings SET status = expired WHERE expirableBookingCondition AND (conflita com os assentos pedidos) RETURNING
    Backend->>Database: DELETE booking_seats da reserva expirada
    Backend->>Database: INSERT booking (pending, expires_at = now() + 10 min) + booking_seats (unique session_id + seat_id)
    Backend->>Database: COMMIT
    Backend->>WS: seat:update released (assentos da reserva velha que não foram pedidos) e booked (assentos novos)
    Backend-->>Frontend: 201
    end

    rect rgb(240, 240, 240)
    Note over Cliente,WS: B. Tentativa de pagamento depois do prazo
    Cliente->>Frontend: paga com a reserva já vencida
    Frontend->>Backend: POST /bookings/:id/payments
    Backend->>Database: SELECT booking FOR UPDATE
    alt expired, ou pending com expires_at passado e sem pagamento em andamento
        Backend-->>Frontend: 409 BOOKING_EXPIRED (não chama o MP)
        Frontend-->>Cliente: "Sua reserva expirou. Escolha os assentos novamente." + volta ao mapa
    end
    end

    rect rgb(240, 240, 240)
    Note over Cliente,WS: C. Pagamento aprovado chega depois da expiração (webhook)
    MP->>Backend: POST /payments/webhook (id do pagamento)
    Backend->>MP: GET pagamento (status nunca vem do corpo da notificação)
    Backend->>Database: atualiza tentativa em payments (approved) + payment_events webhook_received
    Backend->>Database: UPDATE bookings SET status = confirmed WHERE id AND status = pending
    alt reserva ainda pending (inclusive vencida: só estava viva pelo pagamento em andamento)
        Backend->>Database: COMMIT
        Backend->>WS: seat:update booked + e-mail de confirmação (pós-commit)
    else 0 linhas (reserva expired)
        Backend->>Database: UPDATE bookings SET needs_refund_review = true WHERE id AND status = expired AND needs_refund_review = false RETURNING
        Note over Backend,Database: só a 1ª entrega do webhook marca e loga warn (Approved payment on an expired booking), redelivery não repete
        Backend->>Database: COMMIT (reserva continua expired, sem booking_seats, sem e-mail)
        Note over Backend,Database: reserva entra na fila do admin, ver refund/sequence.md (seção 2)
    end
    Backend-->>MP: 200
    end
```

## 4. Alerta de pagamento parado há mais de 24h

Pagamento `pending`/`in_process` segura a reserva além do prazo (a reserva não expira). Se passar de 24h, o sweeper registra um alerta uma única vez, sem mudar o status.

```mermaid
sequenceDiagram
    participant Sweeper as PendingBookingSweeper (a cada 60s)
    participant Database
    participant Log as Logger (pino)

    Sweeper->>Database: UPDATE bookings SET stale_payment_alerted_at = now()<br/>WHERE status = pending AND stale_payment_alerted_at IS NULL<br/>AND created_at <= now() - 24h AND pagamento em andamento<br/>RETURNING id, status do pagamento
    Note over Sweeper,Database: o UPDATE condicional só devolve a linha pra quem chegou primeiro (outra instância ou tick seguinte não alerta de novo)
    loop cada reserva devolvida
        Sweeper->>Log: warn "Payment in flight for more than 24h, review: bookingId, paymentStatus"
    end
    Note over Sweeper,Log: sem expirar nem cancelar: resolver é decisão humana (consultar o MP). Com a observabilidade ligada o warn vai pro Loki com trace_id
```

## Referências

- `apps/api/src/booking/pending-booking.sweeper.ts`, `apps/api/src/booking/booking-lock.ts`
- `apps/api/src/booking/booking.service.ts` (`createBookingForSeats` com expiração lazy, `confirmPaidBooking`, `flagExpiredBookingForRefundReview`)
- `apps/api/src/payment/payment.service.ts` (409 `BOOKING_EXPIRED`), `apps/api/src/booking/booking-expired.exception.ts`
- `apps/web/src/features/checkout/CheckoutPage.tsx` (aviso de reserva expirada)
