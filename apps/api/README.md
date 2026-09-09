# apps/api

Back-end do movietickets — NestJS + Fastify.

REST + WebSocket Gateway. Módulos: Catalog, Seating, Booking, Payment, Auth, Admin. CQRS light (sem event store) — ver `docs/planning.md`.

**Banco/ORM:** PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/) (`postgres` driver). Schema em `src/db/schema.ts`, migrations geradas em `drizzle/`.

Implementado até agora: **Auth MVP** (cadastro + login com JWT, `bcrypt` para hash de senha). Demais módulos entram junto com suas features.

## Rodar

```bash
docker-compose up -d           # Postgres + Valkey, a partir da raiz
cp apps/api/.env.example apps/api/.env
pnpm --filter api db:migrate   # aplica as migrations no Postgres local
pnpm dev:api
```

## Testes

Jest — unitários por service (mockando o banco) e integração batendo em Postgres real.

```bash
pnpm --filter api test               # unitários
pnpm --filter api test:integration   # integração (roda migrations + testa contra Postgres real)
```

`test:integration` espera `DATABASE_URL` e `JWT_SECRET` no ambiente (ver `.env.example`).
