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

Variáveis (lidas pelo Vite na subida/build — reinicie `pnpm dev:web` depois de mudar):

| Variável | Valor |
|---|---|
| `VITE_API_URL` | URL da API (`http://localhost:3000` local, túnel `api` com ngrok) |
| `VITE_MP_PUBLIC_KEY` | Public Key **de teste** (`TEST-...`) da mesma aplicação do `MERCADOPAGO_ACCESS_TOKEN` da API. Vazia = campos de cartão não carregam |

`apps/web/.env` só vale pro `pnpm dev:web`. No Docker (`make up-full`) essas variáveis vêm do `.env` da **raiz** do repo, como build args. Passo a passo, cartão de teste, ngrok e problemas comuns: [Configurar Mercado Pago (sandbox)](../../README.md#configurar-mercado-pago-sandbox) no README raiz.

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
