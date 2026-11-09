# apps/web

Front-end do movietickets — React + Vite, CSR puro (sem SSR/SSG).

SPA: catálogo de filmes/sessões, mapa de assento, checkout, conta do usuário, painel admin. Módulos entram junto com suas features, por pasta em `src/features/<feature>/`.

Features (`src/features/`):

- **catalog** — `/movies`, lista pública de filmes e sessões com filtros de cidade/cinema/data.
- **seating** — `/sessions/:id/seats`, mapa de assentos público com hold/release ao clicar e atualização em tempo real via WebSocket (`socket.io-client`). Visitante deslogado recebe um token de convidado (`POST /auth/guest`, guardado em `localStorage`) pra segurar assentos; ao avançar pro pagamento vai pro login.
- **auth** — login/cadastro; no login manda o token de convidado (`guestToken`) e a API transfere os holds pro usuário, avisando se algum assento foi liberado.
- **checkout** — `/checkout` (rota protegida): cria a reserva, mostra o resumo e paga com cartão via Checkout Transparente (campos seguros do SDK JS do Mercado Pago, `@mercadopago/sdk-js`; o cartão nunca passa pela nossa API). Aviso de reserva expirada e nova tentativa depois de pagamento recusado.
- **tickets** — `/tickets`, "Meus ingressos" com cancelamento.
- **admin** — `/admin/*`, CRUD de filmes, cinemas, salas e sessões (só usuário com `role: "admin"`).

## Rodar

```bash
cp apps/web/.env.example apps/web/.env
pnpm dev:web
```

Variáveis (build-time, lidas pelo Vite — reinicie/rebuilde depois de mudar):

- `VITE_API_URL` — URL da API (padrão local `http://localhost:3000`).
- `VITE_MP_PUBLIC_KEY` — Public Key **de teste** do Mercado Pago, da mesma aplicação do `MERCADOPAGO_ACCESS_TOKEN` da API, usada pelo SDK JS no checkout. Sem ela os campos de cartão não carregam.

No build containerizado (`make up-full`) o `apps/web/.env` é ignorado: os `VITE_*` entram como build args vindos de um `.env` na raiz do repo (ou do shell), e é preciso rebuildar o `web` (`docker compose --profile full up -d --build web`) depois de mudar.

### Com ngrok

Pra abrir o front por URL pública (e receber o webhook do Mercado Pago), sobe os dois túneis com `make expose` (`api` → 3000, `web` → 5173) e ajusta:

- `apps/web/.env` (ou `.env` da raiz, no Docker): `VITE_API_URL=<url-do-túnel-api>` e `VITE_MP_PUBLIC_KEY=<public-key-de-teste>`.
- `apps/api/.env`: `CORS_ORIGIN=http://localhost:5173,<url-do-túnel-web>`, `WEB_URL=<url-do-túnel-web>`, `PUBLIC_API_URL=<url-do-túnel-api>` (base do webhook). No Docker, recria o `api` com `docker compose --profile full up -d --force-recreate api`.

As URLs mudam a cada reinício do ngrok, então repete o ajuste (e o rebuild) toda vez. Passo a passo completo na seção "Rodando com ngrok" do README raiz.

A API precisa estar rodando com CORS liberado pra origem do Vite (`CORS_ORIGIN` no `.env` da API, ver `apps/api/README.md`).

## Testes

Vitest + React Testing Library. Unitário (mocka o módulo de API, 3A) e integração de componente (mocka `fetch` global, Given/When/Then) colocados junto do componente.

```bash
pnpm --filter web test       # Vitest
pnpm --filter web test:e2e   # Playwright (e2e/)
```

O e2e roda num browser de verdade contra a API real: precisa de Postgres + Valkey, migrations, seed e `pnpm dev:api` rodando (o Playwright sobe só o dev server do front). O SDK do Mercado Pago é substituído por um stub (`e2e/helpers/mercadopago.ts`), então não usa credencial nem chama o Mercado Pago.

## Lint/build

```bash
pnpm --filter web lint
pnpm --filter web build
```
