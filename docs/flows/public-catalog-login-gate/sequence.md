# Sequence: Convidado segura assento e transfere no login

Visitante sem login recebe uma identidade de convidado pra segurar assentos; ao fazer login, os holds passam pro usuário mantendo o TTL. Spec: [`spec.md`](./spec.md).

```mermaid
sequenceDiagram
    actor Visitante
    participant Frontend
    participant Backend
    participant Cache

    Visitante->>Frontend: abre /sessions/:id/seats (sem login)
    alt sem guestToken válido no localStorage
        Frontend->>Backend: POST /auth/guest (rate limit 10/min por IP)
        Backend-->>Frontend: { guestToken (JWT kind: guest, sub: guest:<uuid>, 2h), expiresAt }
    end
    Frontend->>Backend: GET /sessions/:id/seats + POST .../seats/:seatId/hold (Bearer guestToken)
    Backend->>Cache: SET seat-hold:{sessionId}:{seatId} guest:<uuid> NX EX 600
    Backend->>Cache: SADD guest-holds:<uuid> {sessionId}:{seatId}
    Backend-->>Frontend: 200 held

    Visitante->>Frontend: clica "Continuar"
    Frontend->>Frontend: /login?returnTo=/sessions/:id/seats
    Visitante->>Frontend: e-mail + senha
    Frontend->>Backend: POST /auth/login { email, password, guestToken }
    Backend->>Backend: valida senha (login falho nunca move hold)
    Backend->>Cache: SET guest-consumed:<uuid> NX (uso único)
    Backend->>Cache: script Lua: troca dono guest:<uuid> → userId com KEEPTTL
    opt usuário passa de 6 holds na sessão
        Backend->>Cache: solta os holds mais antigos do usuário (os do convidado ficam)
    end
    Backend-->>Frontend: seat:update held/released (broadcast)
    Backend-->>Frontend: { accessToken, user, transfer: { keptSeats, releasedSeats } }
    Frontend->>Frontend: apaga guestToken, volta pro mapa e avisa assentos liberados
```

Token de convidado inválido, expirado ou já usado não bloqueia o login: a transferência é pulada e a resposta vem sem `transfer`. Token de convidado é recusado com 401 em booking, pagamento e ingressos (`JwtAuthGuard`).

## Referências

- `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/user-or-guest-auth.guard.ts`
- `apps/api/src/seating/hold-transfer.service.ts`, `apps/api/src/seating/hold-keys.ts`
- `apps/web/src/lib/guest-token.ts`, `apps/web/src/features/auth/LoginPage.tsx`, `apps/web/src/features/seating/SessionSeatsPage.tsx`
