# Classes: Painel admin (CRUD + RolesGuard)

Módulo `AdminModule` (`apps/api/src/admin/`): back office em `/admin/*` com CQRS light (commands e queries separados por recurso, sem event store). Spec: [`spec.md`](./spec.md). O estorno do admin está em [`../refund/class.md`](../refund/class.md).

```mermaid
classDiagram
    direction LR

    class JwtAuthGuard {
        <<guard>>
    }
    class RolesGuard {
        <<guard>>
        exige Roles admin
    }
    class AdminMoviesController {
        <<controller>>
    }
    class AdminCinemasController {
        <<controller>>
    }
    class AdminRoomsController {
        <<controller>>
    }
    class AdminSessionsController {
        <<controller>>
    }
    class MovieQueriesService
    class MovieCommandsService
    class CinemaQueriesService
    class CinemaCommandsService
    class RoomQueriesService
    class RoomCommandsService {
        gera assentos (seat-layout)
    }
    class SessionQueriesService
    class SessionCommandsService {
        regras de sobreposicao e edicao
    }
    class SessionActivityService {
        le atividade da sessao (Postgres + Valkey)
    }
    class SessionRules {
        <<helpers>>
        session-overlap
        session-edit-policy
        session-schedule
    }
    class DRIZZLE {
        <<token>>
    }
    class VALKEY {
        <<token>>
    }

    AdminMoviesController ..> JwtAuthGuard
    AdminMoviesController ..> RolesGuard
    AdminCinemasController ..> RolesGuard
    AdminRoomsController ..> RolesGuard
    AdminSessionsController ..> RolesGuard

    AdminMoviesController --> MovieQueriesService
    AdminMoviesController --> MovieCommandsService
    AdminCinemasController --> CinemaQueriesService
    AdminCinemasController --> CinemaCommandsService
    AdminRoomsController --> RoomQueriesService
    AdminRoomsController --> RoomCommandsService
    AdminSessionsController --> SessionQueriesService
    AdminSessionsController --> SessionCommandsService

    CinemaCommandsService --> CinemaQueriesService
    RoomCommandsService --> RoomQueriesService
    SessionCommandsService --> SessionQueriesService
    SessionCommandsService --> SessionActivityService
    SessionCommandsService ..> SessionRules

    MovieQueriesService --> DRIZZLE
    MovieCommandsService --> DRIZZLE
    CinemaQueriesService --> DRIZZLE
    CinemaCommandsService --> DRIZZLE
    RoomQueriesService --> DRIZZLE
    RoomCommandsService --> DRIZZLE
    SessionQueriesService --> DRIZZLE
    SessionCommandsService --> DRIZZLE
    SessionActivityService --> VALKEY : holds ativos
```

## Notas

- Todos os controllers admin usam `@UseGuards(JwtAuthGuard, RolesGuard)` e `@Roles("admin")` (o `RolesGuard` precisa rodar depois do `JwtAuthGuard`).
- `AdminModule` importa `AuthTokenModule` (guards) e `RefundModule` (`AdminRefundsController` + `RefundReviewQueriesService`).
- Não existe cache de catálogo, então as escritas do painel não invalidam nada.
