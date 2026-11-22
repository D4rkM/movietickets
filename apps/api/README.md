# apps/api

Back-end do movietickets — NestJS + Fastify.

REST + WebSocket Gateway. Módulos: Catalog, Seating, Booking, Payment, Refund, Auth, Admin, Notification (+ MercadoPagoModule com os clientes do SDK, compartilhado por Payment e Refund). CQRS light (sem event store) — ver `docs/planning.md`. Job periódico (`@nestjs/schedule`, `PendingBookingSweeper`, a cada 60s) expira reservas pendentes vencidas e alerta pagamento parado há mais de 24h (`docs/flows/pending-booking-expiry/sequence.md`). Telemetria em `src/telemetry/` + `src/instrumentation.ts` (OpenTelemetry, desligada por padrão).

**Banco/ORM:** PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/) (`postgres` driver). Schema em `src/db/schema.ts`, migrations geradas em `drizzle/`.

**Logs:** `nestjs-pino` — JSON estruturado (pretty-print só fora de produção), com log de request/response automático via `pino-http`. Nível configurável por `LOG_LEVEL` (`.env.example`); `Authorization`, cookies, senha, tokens e dados do pagador ficam de fora do log por redact (`src/telemetry/log-redaction.ts`). Com a telemetria ligada, todo log sai com `trace_id`/`span_id` e também é enviado ao Loki.

**Build:** SWC (`nest-cli.json`), bem mais rápido que o `tsc` puro — o typecheck continua rodando em paralelo (`typeCheck: true`) e também dá pra rodar isolado com `pnpm --filter api typecheck`.

**CORS:** liberado só pra origem configurada em `CORS_ORIGIN` (`.env.example`, default `http://localhost:5173` — origem do `apps/web` em dev).

## Rotas

| Rota | Auth | Módulo |
|---|---|---|
| `POST /auth/register`, `POST /auth/login` (aceita `guestToken` opcional pra transferir holds do convidado) | pública | Auth |
| `POST /auth/guest` — token de convidado (JWT `kind: "guest"`, 2h) | pública, rate limit de 10/min por IP (`@nestjs/throttler`) | Auth |
| `GET /movies` (filtros por cidade/cinema/data) | pública | Catalog |
| `GET /sessions/:id/seats`, `POST`/`DELETE /sessions/:id/seats/:seatId/hold`, `DELETE /sessions/:id/holds` | usuário ou convidado (`UserOrGuestAuthGuard`) | Seating |
| `POST /sessions/:id/book` (vários assentos, atômico), `POST /sessions/:id/seats/:seatId/book` (um assento) | usuário | Booking |
| `GET /bookings/mine` (confirmadas + canceladas/expiradas com estorno), `POST /bookings/:id/confirm` (confirmação mockada, sem gateway — só pra teste manual/e2e) | usuário | Booking |
| `POST /bookings/:id/cancel` (cancela e estorna o pagamento aprovado no Mercado Pago, até 2h antes da sessão; reserva `confirmed` sem pagamento aprovado cancela direto) | usuário | Refund |
| `GET /bookings/:id/payment-summary`, `POST /bookings/:id/payments` (Checkout Transparente) | usuário | Payment |
| `POST /payments/webhook` | pública (chamada pelo Mercado Pago) | Payment |
| `/admin/movies`, `/admin/cinemas`, `/admin/rooms`, `/admin/sessions` (CRUD) | usuário com `role: "admin"` | Admin |
| `GET /admin/refunds/review` (fila de revisão: reservas com `needs_refund_review` e estornos `requested` parados), `POST /admin/bookings/:id/refund` (estorna a reserva da fila) | usuário com `role: "admin"` | Admin + Refund |
| WebSocket namespace `/seating` (`join`/`leave`, evento `seat:update`) | usuário ou convidado (token no handshake) | Seating |

"Usuário" = `JwtAuthGuard`, que recusa token de convidado com 401. Regras de negócio de cada feature em `docs/flows/<feature>/spec.md`; collection pra testar à mão em `docs/bruno/`.

## Variáveis de ambiente

Ver `.env.example`. Principais:

- `DATABASE_URL`, `VALKEY_URL` — Postgres e Valkey (Valkey precisa aceitar `CONFIG SET notify-keyspace-events`, usado pra detectar hold expirado).
- `JWT_SECRET`, `JWT_EXPIRES_IN` (padrão `1h`) — token de usuário. O token de convidado tem validade fixa de 2h.
- `CORS_ORIGIN` — origens liberadas, separadas por vírgula.
- `MERCADOPAGO_ACCESS_TOKEN` — Access Token **de teste** (`TEST-...`) do Mercado Pago; lido no boot (a API não sobe sem a variável definida). Ver [Configurar Mercado Pago (sandbox)](../../README.md#configurar-mercado-pago-sandbox).
- `WEB_URL` — sem uso (sobra do Checkout Pro).
- `PUBLIC_API_URL` — base do `notification_url` do webhook mandado ao Mercado Pago (URL pública/ngrok pra receber webhook localmente, ver README raiz).
- `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` — e-mail de confirmação de compra (Mailpit em dev, porta 1025).
- `LOG_LEVEL`.
- `OTEL_*` (OpenTelemetry, opcionais) — a telemetria só liga quando `OTEL_EXPORTER_OTLP_ENDPOINT` está preenchida (ex.: `http://localhost:4318` com `make obs-up`) e `OTEL_SDK_DISABLED` não é `true`; vazia, nada do SDK é carregado.

  | Variável | Padrão | Efeito |
  |---|---|---|
  | `OTEL_EXPORTER_OTLP_ENDPOINT` | vazia (desligado) | Destino OTLP/HTTP (protobuf). Também valem os endpoints por sinal (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `_METRICS_`, `_LOGS_`) |
  | `OTEL_SERVICE_NAME` | `movietickets-api` | `service.name` |
  | `OTEL_RESOURCE_ATTRIBUTES` | `deployment.environment.name=local` (no `.env.example`) | Atributos do recurso (ex.: `service.version`) |
  | `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio` / `1.0` | Amostragem (100% em dev) |
  | `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Intervalo de export de métricas, em ms |
  | `OTEL_SDK_DISABLED` | — | `true` força desligado mesmo com endpoint |

## Rodar

Via `make` (raiz do monorepo, ver `make help`):

```bash
make up        # Postgres + Valkey
cp apps/api/.env.example apps/api/.env
make migrate
make seed      # cria admin@movietickets.dev + cliente@movietickets.dev + cliente2@movietickets.dev
make dev-api
```

Ou direto:

```bash
docker compose up -d           # Postgres + Valkey, a partir da raiz
cp apps/api/.env.example apps/api/.env
pnpm --filter api db:migrate   # aplica as migrations no Postgres local
pnpm --filter api db:seed      # popula usuários + sessão de teste + catálogo
pnpm dev:api
```

`db:seed` é idempotente — roda quantas vezes quiser sem duplicar nada:
- Usuários (`onConflictDoNothing` no email): `admin@movietickets.dev`, `cliente@movietickets.dev` e `cliente2@movietickets.dev`, senha `password123` pros três. Os dois clientes servem pra testar WebSocket/concorrência de assento com duas sessões logadas ao mesmo tempo.
- Fixture de sessão (filme + cinema + sala de 13 fileiras com corredores + sessão futura), pra testar `GET /sessions/:id/seats` manualmente. O `id` da sessão criada é impresso no console ao rodar o seed.
- Filmes extras de catálogo, cada um com cinema próprio (cidade aleatória), sala e uma sessão futura, pra popular `GET /movies` e os filtros. As datas de sessão são sorteadas de novo a cada execução, pra não saírem do catálogo.

### Rodar containerizado (sem Node/pnpm no host)

`Dockerfile` (multi-stage, build via monorepo pnpm workspace) sobe a API rodando migrations + seed no boot (idempotente) — pensado pra quem quer testar sem instalar nada além de Docker. Ver `make up-full` / `make down-full` na raiz do monorepo, ou:

```bash
docker compose --profile full up -d --build
```

## Painel admin

Rotas em `/admin/*` (filmes, cinemas, salas e sessões) exigem token de usuário com `role: "admin"`: sem token, token inválido/expirado ou token de convidado → 401; usuário `customer` → 403. Regras de negócio na spec `docs/flows/admin-panel/spec.md`.

### Como criar um admin

Em dev/local, o seed já cria `admin@movietickets.dev` (senha `password123`). Em outros ambientes, a pessoa se cadastra normalmente (`POST /auth/register` sempre cria `customer`, mesmo mandando `role` no body) e é promovida por SQL manual:

```sql
UPDATE users SET role = 'admin' WHERE email = '<email>';
```

O papel vai dentro do JWT, então a pessoa precisa **logar de novo** pra receber um token com `role: "admin"`. Pelo mesmo motivo, quem é rebaixado continua com acesso admin até o token expirar (`JWT_EXPIRES_IN`, padrão `1h`).

## Observabilidade

Traces, métricas e logs via OpenTelemetry pro `grafana/otel-lgtm` (perfil `observability` do docker compose). `make obs-up` na raiz sobe o Grafana em `http://localhost:3001` (`admin`/`admin`); com `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` no `.env`, `pnpm dev:api` passa a exportar. Os scripts `start:dev` e `start:prod` já carregam `dist/instrumentation.js` com `--require` antes da aplicação. Passo a passo no README da raiz (seção "Observabilidade") e fluxo em `docs/flows/observability/sequence.md`.

## Estorno

`POST /bookings/:id/cancel` cancela a reserva `confirmed` até 2h antes da sessão e estorna o valor integral pela Refunds API do Mercado Pago (chave de idempotência = `refunds.id`). Se o estorno falha, a reserva continua `confirmed`. Pagamento aprovado que chega numa reserva já `expired` vai pra fila do admin (`GET /admin/refunds/review`) e é estornado em `POST /admin/bookings/:id/refund`. O webhook (`POST /payments/webhook`) conclui estornos que ficaram em andamento. Regras na spec `docs/flows/refund/spec.md` e fluxos em `docs/flows/refund/sequence.md`.

## Testes

Jest — unitários por service (mockando o banco) e integração batendo em Postgres real.

```bash
pnpm --filter api test               # unitários (com coverage, mínimo 75% — ver jest.config.js)
pnpm --filter api test:integration   # integração (roda migrations + testa contra Postgres real)
```

`test:integration` aplica as migrations e roda contra o Postgres de `DATABASE_URL` e o Valkey de `VALKEY_URL` (os testes usam `JWT_SECRET=test-secret` se não houver um definido, e mockam o cliente do Mercado Pago). Os specs ficam em `test/*.e2e-spec.ts`; os de regra de negócio citam o AC da spec no título do `it`. `test/observability-smoke.e2e-spec.ts` sobe a API **compilada** como processo filho, então rode `pnpm --filter api build` antes.

## Migrations

Schema em `src/db/schema.ts`. Depois de mudar o schema: `pnpm --filter api db:generate` (gera o SQL em `drizzle/`) e `pnpm --filter api db:migrate`. Detalhe das tabelas em `docs/schema.md`.
