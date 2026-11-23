# Classes: Reserva de assentos (booking)

Módulo `BookingModule` (`apps/api/src/booking/`): cria a reserva `pending` a partir dos assentos segurados, confirma, cancela (parte da transação do estorno) e expira reservas vencidas. Fluxo em [`sequence.md`](./sequence.md).

```mermaid
classDiagram
    direction LR

    class BookingController {
        <<controller>>
        POST sessions/ID/book
        POST sessions/ID/seats/ID/book
    }
    class BookingConfirmationController {
        <<controller>>
        POST bookings/ID/confirm
        confirmacao mockada, so com ENABLE_TEST_ROUTES=true
    }
    class TestRoutesGuard {
        <<guard>>
        404 se ENABLE_TEST_ROUTES nao for true
    }
    class MyBookingsController {
        <<controller>>
        GET bookings/mine
    }
    class BookingService {
        <<service>>
        createBookingForSeats()
        confirmBooking()
        confirmPaidBooking()
        cancelConfirmedBooking()
        getMyBookings()
    }
    class PendingBookingSweeper {
        <<job>>
        expira bookings pending vencidos
        alerta pagamento parado ha 24h
    }
    class BookingLock {
        <<helpers>>
        activeBookingCondition()
        expirableBookingCondition()
        cancellableUntil()
    }
    class JwtAuthGuard {
        <<guard>>
    }
    class SeatingService {
        <<service>>
    }
    class SeatingGateway {
        <<gateway>>
    }
    class NotificationService {
        <<service>>
        sendBookingConfirmationEmail()
    }
    class DRIZZLE {
        <<token>>
    }

    BookingController ..> JwtAuthGuard : UseGuards
    BookingConfirmationController ..> TestRoutesGuard : UseGuards (antes do JwtAuthGuard)
    BookingConfirmationController ..> JwtAuthGuard : UseGuards
    MyBookingsController ..> JwtAuthGuard : UseGuards
    BookingController --> BookingService
    BookingConfirmationController --> BookingService
    MyBookingsController --> BookingService
    BookingService --> DRIZZLE : Inject
    BookingService --> SeatingService : libera holds dos assentos reservados
    BookingService --> SeatingGateway : broadcast booked/released
    BookingService --> NotificationService : e-mail de confirmacao
    BookingService ..> BookingLock : regra de trava de assento
    PendingBookingSweeper --> DRIZZLE : Inject
    PendingBookingSweeper --> SeatingGateway : broadcast released
    PendingBookingSweeper ..> BookingLock
```

## Notas

- `BookingModule` importa `AuthModule`, `SeatingModule` e `NotificationModule`; exporta `BookingService` (usado por `PaymentModule` e `RefundModule`).
- `cancelConfirmedBooking` recebe a transação de quem chama (o `RefundService`), por isso o cancelamento e o registro do estorno ficam atômicos.
- `BookingConfirmationController` (`POST /bookings/:id/confirm`) é a confirmação mockada, sem pagamento: o `TestRoutesGuard` roda antes do `JwtAuthGuard` e responde 404, como se a rota não existisse, a menos que `ENABLE_TEST_ROUTES=true` (lido a cada request). Spec: [`../test-routes/spec.md`](../test-routes/spec.md).
- Consistência de assento vem do Postgres (`unique (session_id, seat_id)` em `booking_seats`); o hold no Valkey é só temporário. Ver [`../../schema.md`](../../schema.md).
