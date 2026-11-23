# Classes: Autenticação (login, registro e convidado)

Módulos `AuthModule` e `AuthTokenModule` (`apps/api/src/auth/`). Convidado: JWT `kind: "guest"` de 2h, só pra segurar assento antes do login. Spec: [`../public-catalog-login-gate/spec.md`](../public-catalog-login-gate/spec.md).

```mermaid
classDiagram
    direction LR

    class AuthController {
        <<controller>>
        POST register
        POST login
        POST guest
    }
    class ThrottlerGuard {
        <<guard>>
        10 tokens por minuto por IP
    }
    class AuthService {
        <<service>>
        register()
        login()
        issueGuestToken()
    }
    class JwtPayload {
        <<types>>
        UserJwtPayload
        GuestJwtPayload
        isGuestPayload()
    }
    class JwtAuthGuard {
        <<guard>>
        somente token de usuario
    }
    class UserOrGuestAuthGuard {
        <<guard>>
        usuario ou convidado
    }
    class RolesGuard {
        <<guard>>
        le metadata de Roles
    }
    class Roles {
        <<decorator>>
        ROLES_KEY
    }
    class AuthTokenModule {
        <<module>>
        JwtModule com JWT_SECRET
    }
    class JwtService {
        <<JwtService>>
    }
    class HoldTransferService {
        <<service>>
        transferGuestHolds()
    }
    class DRIZZLE {
        <<token>>
    }

    AuthController --> AuthService
    AuthController ..> ThrottlerGuard : POST guest
    AuthService --> DRIZZLE : users
    AuthService --> JwtService : assina tokens
    AuthService --> HoldTransferService : login com guestToken
    AuthService ..> JwtPayload
    JwtAuthGuard --> JwtService
    UserOrGuestAuthGuard --> JwtService
    RolesGuard ..> Roles : Reflector
    AuthTokenModule *-- JwtAuthGuard
    AuthTokenModule *-- UserOrGuestAuthGuard
    AuthTokenModule *-- RolesGuard
    AuthTokenModule ..> JwtService : exporta JwtModule
```

## Notas

- `AuthModule` importa `AuthTokenModule`, `SeatingModule` e `ThrottlerModule`, e reexporta `AuthTokenModule`.
- `AuthTokenModule` foi separado de `AuthModule` pra `SeatingModule` (e `RefundModule`/`AdminModule`) usarem os guards sem importar `AuthModule`, que evita ciclo (`AuthModule` -> `SeatingModule` por causa da transferência de holds).
- Token de convidado é recusado (401) em booking, pagamento e ingressos: esses controllers usam `JwtAuthGuard`; só `SeatingController` usa `UserOrGuestAuthGuard`.
