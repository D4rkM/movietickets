# Classes/componentes: Frontend (`apps/web/src`)

Visão por feature (`features/*`) do front React: páginas, hooks, contexto e clients de API. Só as dependências relevantes; as telas do admin (`features/admin`) aparecem agrupadas.

```mermaid
classDiagram
    direction LR

    class App {
        <<rotas>>
    }
    class ProtectedRoute {
        <<lib>>
        exige login
    }
    class AdminRoute {
        <<lib>>
        exige role admin
    }
    class AuthProvider {
        <<contexto>>
        useAuth()
        token e usuario no storage
    }
    class MoviesPage {
        <<page>>
    }
    class SessionSeatsPage {
        <<page>>
    }
    class SeatMap {
        <<component>>
    }
    class ReleasedSeatsNotice {
        <<component>>
    }
    class CheckoutPage {
        <<page>>
    }
    class TicketsPage {
        <<page>>
        cancelar com estorno
    }
    class LoginPage {
        <<page>>
    }
    class RegisterPage {
        <<page>>
    }
    class AdminPages {
        <<pages>>
        filmes, cinemas, salas, sessoes
    }
    class useSeatingCredentials {
        <<hook>>
        usuario ou convidado
    }
    class useSeatingSocket {
        <<hook>>
        socket.io namespace seating
    }
    class CatalogApi {
        <<apiClient>>
        listMovies()
    }
    class SeatingApi {
        <<apiClient>>
        getSeatMap() holdSeat() bookSeats()
    }
    class CheckoutApi {
        <<apiClient>>
        getPaymentSummary() submitPayment()
    }
    class MercadoPagoSdk {
        <<sdkWrapper>>
        SDK JS, campos seguros do cartao
    }
    class TicketsApi {
        <<apiClient>>
        getMyTickets() cancelBooking()
    }
    class AuthApi {
        <<apiClient>>
        login() register()
    }
    class AdminApi {
        <<apiClient>>
        CRUD /admin/*
    }
    class ApiClient {
        <<lib>>
        apiFetch() UnauthorizedError
    }
    class GuestToken {
        <<lib>>
        ensureGuestToken()
    }

    App --> ProtectedRoute
    App --> AdminRoute
    App --> AuthProvider
    ProtectedRoute --> CheckoutPage
    ProtectedRoute --> TicketsPage
    AdminRoute --> AdminPages
    ProtectedRoute ..> AuthProvider
    AdminRoute ..> AuthProvider

    MoviesPage --> CatalogApi
    SessionSeatsPage --> SeatMap
    SessionSeatsPage --> ReleasedSeatsNotice
    SessionSeatsPage --> useSeatingCredentials
    SessionSeatsPage --> useSeatingSocket
    SessionSeatsPage --> SeatingApi
    useSeatingCredentials --> AuthProvider
    useSeatingCredentials --> GuestToken
    CheckoutPage --> AuthProvider
    CheckoutPage --> SeatingApi
    CheckoutPage --> CheckoutApi
    CheckoutPage --> MercadoPagoSdk
    TicketsPage --> AuthProvider
    TicketsPage --> TicketsApi
    LoginPage --> AuthProvider
    RegisterPage --> AuthApi
    AuthProvider --> AuthApi : login com guestToken
    AuthProvider --> GuestToken
    AdminPages --> AdminApi
    AdminPages --> AuthProvider

    CatalogApi --> ApiClient
    SeatingApi --> ApiClient
    CheckoutApi --> ApiClient
    TicketsApi --> ApiClient
    AuthApi --> ApiClient
    AdminApi --> ApiClient
```

## Notas

- Catálogo e mapa de assentos são públicos; o visitante segura assento como convidado (token de `POST /auth/guest`, guardado por `GuestToken`) e o login transfere os holds (`AuthProvider` envia o `guestToken` no login).
- `ProtectedRoute` cobre `/checkout` e `/tickets`; `AdminRoute` cobre `/admin/*`.
- `CheckoutPage` usa o SDK JS do Mercado Pago só pra tokenizar o cartão; o pagamento em si passa pelo back (`CheckoutApi`).
