# apps/api

Back-end do movietickets — NestJS + Fastify.

REST + WebSocket Gateway. Módulos: Catalog, Seating, Booking, Payment, Auth, Admin. CQRS light (sem event store) — ver `docs/planning.md`.

**Banco/ORM:** PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/) (`postgres` driver). Schema em `src/db/schema.ts`, migrations geradas em `drizzle/`.

**Logs:** `nestjs-pino` — JSON estruturado (pretty-print só fora de produção), com log de request/response automático via `pino-http`. Nível configurável por `LOG_LEVEL` (`.env.example`); `Authorization` e `body.password` ficam de fora do log por redact.

**Build:** SWC (`nest-cli.json`), bem mais rápido que o `tsc` puro — o typecheck continua rodando em paralelo (`typeCheck: true`) e também dá pra rodar isolado com `pnpm --filter api typecheck`.

Implementado até agora: **Auth MVP** (cadastro + login com JWT, `bcrypt` para hash de senha). Demais módulos entram junto com suas features.

## Rodar

Via `make` (raiz do monorepo, ver `make help`):

```bash
make up        # Postgres + Valkey
cp apps/api/.env.example apps/api/.env
make migrate
make seed      # cria admin@movietickets.dev + cliente@movietickets.dev
make dev-api
```

Ou direto:

```bash
docker compose up -d           # Postgres + Valkey, a partir da raiz
cp apps/api/.env.example apps/api/.env
pnpm --filter api db:migrate   # aplica as migrations no Postgres local
pnpm --filter api db:seed      # popula usuários + sessão de teste
pnpm dev:api
```

`db:seed` é idempotente — roda quantas vezes quiser sem duplicar nada:
- Usuários (`onConflictDoNothing` no email): `admin@movietickets.dev` e `cliente@movietickets.dev`, senha `password123` pros dois.
- Fixture de sessão (movie + cinema + room + 8 seats + session), pra testar `GET /sessions/:id/seats` manualmente sem precisar de endpoint de Catálogo/Admin ainda. O `id` da sessão criada é impresso no console ao rodar o seed.

### Rodar containerizado (sem Node/pnpm no host)

`Dockerfile` (multi-stage, build via monorepo pnpm workspace) sobe a API rodando as migrations no boot — pensado pra quem quer testar sem instalar nada além de Docker. Ver `make up-full` / `make down-full` na raiz do monorepo, ou:

```bash
docker compose --profile full up -d --build
```

## Testes

Jest — unitários por service (mockando o banco) e integração batendo em Postgres real.

```bash
pnpm --filter api test               # unitários (com coverage, mínimo 75% — ver jest.config.js)
pnpm --filter api test:integration   # integração (roda migrations + testa contra Postgres real)
```

`test:integration` espera `DATABASE_URL` e `JWT_SECRET` no ambiente (ver `.env.example`).
