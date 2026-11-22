# Classes: Assentos (hold no Valkey + WebSocket)

Módulo `SeatingModule` (`apps/api/src/seating/`): mapa de assentos, hold temporário no Valkey (TTL de 600s), eventos em tempo real por WebSocket e transferência dos holds de convidado no login. Fluxos em [`../booking/sequence.md`](../booking/sequence.md) e [`../public-catalog-login-gate/sequence.md`](../public-catalog-login-gate/sequence.md).

```mermaid
classDiagram
    direction LR

    class SeatingController {
        <<controller>>
        GET ID/seats
        POST ID/seats/SEATID/hold
        DELETE ID/seats/SEATID/hold
        DELETE ID/holds
    }
    class UserOrGuestAuthGuard {
        <<guard>>
        aceita token de usuario ou convidado
    }
    class SeatingService {
        <<service>>
        getSeatMap()
        holdSeat()
        releaseSeat()
        releaseAllHoldsForUser()
        releaseHoldsForBookedSeats()
    }
    class SeatingGateway {
        <<gateway>>
        handleConnection()
        join / leave
        broadcastSeatUpdate()
    }
    class HoldExpiryListener {
        <<listener>>
        keyspace notifications do Valkey
        expiracao vira evento released
    }
    class HoldTransferService {
        <<service>>
        transferGuestHolds()
    }
    class HoldKeys {
        <<helpers>>
        holdKey()
        guestHoldsKey()
        guestConsumedKey()
    }
    class JwtService {
        <<JwtModule>>
    }
    class VALKEY {
        <<token>>
    }
    class DRIZZLE {
        <<token>>
    }
    class AuthService {
        <<service>>
    }
    class BookingService {
        <<service>>
    }

    SeatingController ..> UserOrGuestAuthGuard : UseGuards
    SeatingController --> SeatingService
    SeatingService --> DRIZZLE : booking_seats que travam assento
    SeatingService --> VALKEY : SET NX EX / SCAN / MGET
    SeatingService --> SeatingGateway : broadcast held/released
    SeatingService ..> HoldKeys
    SeatingGateway --> JwtService : valida token na conexao
    HoldExpiryListener --> SeatingGateway : released
    HoldExpiryListener ..> HoldKeys
    HoldTransferService --> VALKEY
    HoldTransferService --> SeatingGateway
    HoldTransferService ..> HoldKeys
    AuthService --> HoldTransferService : login transfere holds
    BookingService --> SeatingService : libera holds ao reservar
    BookingService --> SeatingGateway : booked
    UserOrGuestAuthGuard --> JwtService
```

## Notas

- `SeatingModule` importa só `AuthTokenModule` (e não `AuthModule`) pra evitar ciclo: `AuthModule` depende de `SeatingModule` por causa da transferência de holds no login.
- Exporta `SeatingGateway`, `SeatingService` e `HoldTransferService`.
- Chaves no Valkey: ver [`../../schema.md`](../../schema.md) ("Fora do Postgres").
