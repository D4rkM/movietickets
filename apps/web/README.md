# apps/web

Front-end do movietickets — React + Vite, CSR puro (sem SSR/SSG).

SPA: catálogo de filmes/sessões, mapa de assento, checkout, conta do usuário, painel admin. Módulos entram junto com suas features, por pasta em `src/features/<feature>/`.

Implementado até agora: **SeatMap** (`src/features/seating/`) — componente que busca `GET /sessions/:id/seats` no mount e renderiza o mapa de assentos com 4 estados visuais (livre, ocupado, segurado por outro, selecionado por mim) + legenda.

## Rodar

```bash
cp apps/web/.env.example apps/web/.env   # VITE_API_URL aponta pra API local
pnpm dev:web
```

A API precisa estar rodando com CORS liberado pra origem do Vite (`CORS_ORIGIN` no `.env` da API, ver `apps/api/README.md`).

## Testes

Vitest + React Testing Library. Unitário (mocka o módulo de API, 3A) e integração de componente (mocka `fetch` global, Given/When/Then) colocados junto do componente.

```bash
pnpm --filter web test
```

## Lint/build

```bash
pnpm --filter web lint
pnpm --filter web build
```
