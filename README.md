# movietickets

Site simplificado de venda de ingressos de cinema (estilo ingresso.com), com foco em seleção de assento sem double-booking.

Monorepo (pnpm workspaces):

- `apps/web` — front (React + Vite). Ver `apps/web/README.md`.
- `apps/api` — back (NestJS). Ver `apps/api/README.md`.
- `docs/` — documentação: `docs/planning.md` (decisões de stack/arquitetura), `docs/c4/` (diagramas C4), `docs/flows/<feature>/` (sequência/classe por feature).

## Subir o ambiente local

```bash
docker-compose up -d   # Postgres + Valkey
pnpm install
pnpm dev:api            # apps/api
pnpm dev:web             # apps/web
```

## Testes

```bash
pnpm test        # unitários + integração, todos os apps
pnpm test:e2e
```

Regra do projeto: toda feature nova precisa de teste unitário e, quando cruzar camadas (API+banco, API+cache), teste de integração também — ver `CLAUDE.md`.
