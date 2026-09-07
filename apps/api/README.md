# apps/api

Back-end do movietickets — NestJS.

REST + WebSocket Gateway. Módulos: Catalog, Seating, Booking, Payment, Auth, Admin. CQRS light (sem event store) — ver `docs/planning.md`.

Ainda não inicializado — scaffold do projeto Nest entra na primeira feature.

## Rodar

```bash
docker-compose up -d   # Postgres + Valkey, a partir da raiz
pnpm dev:api
```

## Testes

Jest, unitários por service/handler e integração batendo em Postgres/Valkey reais.

```bash
pnpm --filter api test
```
