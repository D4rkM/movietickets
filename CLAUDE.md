# movietickets

Monorepo (pnpm workspaces): `apps/web` (React + Vite), `apps/api` (NestJS), `docs/` (C4, planning, per-feature flow diagrams).

Referência de decisões de arquitetura e stack: `docs/planning.md`. Diagramas macro: `docs/c4/` (`.drawio`, abrir em app.diagrams.net). Diagramas de sequência/classe por feature: `docs/flows/<feature>/`.

## Regra permanente: testes

Toda feature nova precisa vir com teste unitário. Se envolver fluxo entre camadas (API+banco, API+cache/Redis, seat hold/booking), precisa também de teste de integração. Não considerar uma feature pronta sem isso — sem exceção, mesmo pra mudanças pequenas.

- Front (`apps/web`): Vitest + React Testing Library.
- Back (`apps/api`): Jest (padrão NestJS), testes de integração batendo em Postgres/Redis reais (docker-compose ou testcontainers).

## Arquitetura

- Sem event sourcing completo. CQRS "light": commands/queries separados por módulo Nest, sem event store.
- Assento: consistência forte via Postgres (constraint única `session_id + seat_id` + transação). Redis só pra hold temporário (TTL) durante checkout, não é fonte de verdade definitiva.
- Comunicação front↔back: REST por padrão. Não trocar pra GraphQL sem necessidade concreta identificada.
