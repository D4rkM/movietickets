# movietickets

Site de compra de ingressos para filmes: o cliente cria conta, navega pelo catálogo de filmes e sessões, escolhe os assentos na sala e finaliza a compra. Foco principal do projeto é a seleção de assento funcionar bem — sem double-booking mesmo com concorrência —, junto com catálogo, checkout e histórico de ingressos do usuário.

Monorepo (pnpm workspaces):

- `apps/web` — front (React + Vite). Ver `apps/web/README.md`.
- `apps/api` — back (NestJS). Ver `apps/api/README.md`.
- `docs/` — documentação: `docs/planning.md` (decisões de stack/arquitetura), `docs/c4/` (diagramas C4), `docs/flows/<feature>/` (sequência/classe por feature), `docs/bruno/` (collection do [Bruno](https://www.usebruno.com/) pra testar as rotas manualmente).

## Instalação

Pré-requisitos:

- **[Node.js](https://nodejs.org/) 24+** — versão fixada em [`.nvmrc`](./.nvmrc); vale gerenciar com [nvm](https://github.com/nvm-sh/nvm) ou [fnm](https://github.com/Schniz/fnm) (`nvm use` na raiz do repo já pega a versão certa) em vez de depender da instalação global da máquina.
- **pnpm** — via Corepack, já vem com o Node (`corepack enable`).
- **[Docker](https://www.docker.com/) ou [Podman](https://podman.io/)** — o Makefile detecta automaticamente qual tá instalado (prioriza `docker`, cai pro `podman` se não achar).
- `make` — opcional, comandos diretos equivalentes em [Windows](#windows) logo abaixo (útil sem `make` em qualquer SO).
- **[ngrok](https://ngrok.com/)** — só necessário pra receber o webhook do Mercado Pago localmente e acessar o app por URL pública (ver [Rodando com ngrok](#rodando-com-ngrok-webhook-do-mercado-pago)); pagar com cartão de teste funciona sem ele. Precisa de conta (free tier serve); exporte o authtoken como `NGROK_AUTHTOKEN` no shell (pega em https://dashboard.ngrok.com/get-started/your-authtoken) — **não** `ngrok config add-authtoken`, que salva na config default do ngrok e é ignorado quando `make expose` passa `--config ngrok.yml` (o ngrok não faz merge dos dois arquivos).

## Subir o ambiente local

### macOS / Linux

Tudo funciona nativo, sem passo extra — `make`, `docker`/`podman` e `pnpm` já rodam direto no terminal.

Os dois comandos essenciais:

```bash
make install    # pnpm install
make up-full     # infra + api + web + Drizzle Studio, containerizado
```

A `api` (buildada de `apps/api/Dockerfile`) já aplica as migrations e popula o banco com dados de teste sozinha no boot (idempotente — seguro rodar de novo a cada restart do container). O `web` (buildado de `apps/web/Dockerfile`) é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (interface pra ver/editar o banco) em `http://localhost:4983`, [Mailpit](https://github.com/axllent/mailpit) (caixa de e-mail fake, onde chega o e-mail de confirmação de compra) em `http://localhost:8025`, login de teste: `cliente@movietickets.dev` / `password123` (ou `admin@movietickets.dev` pro papel de admin e a área `/admin`, ou `cliente2@movietickets.dev` pra testar com dois usuários ao mesmo tempo — ver `apps/api/README.md`). Pra derrubar: `make down-full`.

Pra pagar no checkout, configure as credenciais de teste do Mercado Pago antes de subir (ver [Pagamento com Mercado Pago](#pagamento-com-mercado-pago-sandbox)).

Ou por partes, rodando cada app localmente com hot reload em vez de containerizado:

```bash
make install          # pnpm install
make up                # Postgres + Valkey + Mailpit (docker compose)
make migrate           # aplica migrations no Postgres local
make seed              # popula usuários de teste
make dev-api            # apps/api
make dev-web             # apps/web
make studio              # Drizzle Studio (opcional)
```

Ver todos os comandos com `make help`.

### Windows

`make` não roda nativo no Windows (usa sintaxe de shell POSIX que `cmd`/PowerShell não entendem, mesmo com `make` instalado via choco/scoop). Duas opções:

- **Recomendado: [WSL2](https://learn.microsoft.com/windows/wsl/install)** — dá um ambiente Linux de verdade, onde `make` funciona igual ao documentado em **macOS / Linux** acima (ative **Docker Desktop → Settings → Resources → WSL Integration** pra distro instalada).
- **Sem WSL** (PowerShell/cmd nativo): funciona também, só sem `make` — usa os comandos diretos abaixo.

Os dois comandos essenciais, sem `make`:

```bash
# 1. instalar as dependências
pnpm install

# 2. subir tudo containerizado — infra + api + web + Drizzle Studio
docker compose --profile full up -d --build
```

A `api` já aplica as migrations e popula o banco sozinha no boot (idempotente), o `web` é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) em `http://localhost:4983`, Mailpit em `http://localhost:8025`, login de teste: `cliente@movietickets.dev` / `password123` (usuários de teste completos em `apps/api/README.md`). Pra derrubar: `docker compose --profile full down`. Pra pagar no checkout, ver [Pagamento com Mercado Pago](#pagamento-com-mercado-pago-sandbox) (no PowerShell, `$env:VITE_MP_PUBLIC_KEY="<public-key>"` no lugar do `export`, ou um `.env` na raiz do repo).

Todo `make <alvo>` do [`Makefile`](./Makefile) tem um comando direto equivalente:

| `make <alvo>` | Comando direto |
|---|---|
| `install` | `pnpm install` |
| `up` | `docker compose up -d` |
| `down` | `docker compose down` |
| `up-full` | `docker compose --profile full up -d --build` |
| `down-full` | `docker compose --profile full down` |
| `migrate` | `pnpm --filter api db:migrate` |
| `seed` | `pnpm --filter api db:seed` |
| `studio` | `pnpm --filter api db:studio` |
| `dev-api` | `pnpm dev:api` |
| `dev-web` | `pnpm dev:web` |
| `build` | `pnpm build` |
| `lint` | `pnpm lint` |
| `test` | `pnpm --filter api test` |
| `test-integration` | `pnpm --filter api test:integration` |

## Testes

```bash
make test               # unitários (apps/api)
make test-integration   # integração (apps/api), contra Postgres + Valkey locais

# ou:
pnpm test        # unitários de todos os apps (Jest na api, Vitest no web)
pnpm test:e2e    # e2e do front (Playwright, apps/web/e2e)
```

`make test-integration` aplica as migrations e roda contra o banco de `DATABASE_URL` (ver `apps/api/README.md`). O e2e do Playwright espera a API já rodando (`make up` + `make migrate` + `make seed` + `make dev-api`); ele sobe sozinho só o dev server do front e troca o SDK do Mercado Pago por um stub, então não precisa de credencial.

Teste manual completo (checklist pra QA/PO/dev antes de release): [`docs/qa/roteiro-testes.md`](./docs/qa/roteiro-testes.md).

Regra do projeto: toda feature nova precisa de teste unitário e, quando cruzar camadas (API+banco, API+cache), teste de integração também — ver `CLAUDE.md`.

## Contribuindo

Pré-requisitos além do Node/pnpm/Docker:

- **[gitleaks](https://github.com/gitleaks/gitleaks)** — CLI externo, não é dependência npm. Necessário pro hook de pre-commit (escaneia segredos em commits que tocam `apps/web` ou `apps/api`). Sem ele instalado, commits nesses paths falham com erro pedindo pra instalar.

  Instalação:
  ```bash
  # macOS (Homebrew)
  brew install gitleaks

  # Linux (via go)
  go install github.com/gitleaks/gitleaks/v8@latest

  # Windows (via scoop)
  scoop install gitleaks
  ```
  Outras opções (binário direto, Docker) na [documentação oficial](https://github.com/gitleaks/gitleaks#installing).

Depois de clonar:

```bash
pnpm install   # instala deps e ativa os git hooks (husky) via script "prepare"
```

Hooks configurados (`.husky/`):
- **pre-commit**: `gitleaks protect --staged` — só roda se o commit tocar `apps/web/**` ou `apps/api/**`
- **commit-msg**: `commitlint` — exige [Conventional Commits](https://www.conventionalcommits.org/), título até 73 caracteres

### Pagamento com Mercado Pago (sandbox)

O checkout usa o **Checkout Transparente** (Core Methods): o front monta os campos de cartão com o SDK JS do Mercado Pago e gera um token; a API (`PaymentModule`) cria o pagamento direto na Payments API com esse token. Não há redirect pra página do Mercado Pago. Precisa de credenciais **de teste** de uma aplicação no [painel de desenvolvedor do Mercado Pago](https://www.mercadopago.com.br/developers/panel/app):

- **Access Token** → `MERCADOPAGO_ACCESS_TOKEN` em `apps/api/.env` (obrigatório: a API lê no boot).
- **Public Key** (da mesma aplicação do Access Token) → `VITE_MP_PUBLIC_KEY` no front. É lida em build-time pelo Vite (sem hot-reload):
  - **`pnpm dev:web` (nativo)**: `apps/web/.env`.
  - **`make up-full` (containerizado)**: `apps/web/.env` é ignorado no build (`.dockerignore` exclui `.env` de todas as imagens, de propósito) — coloca `VITE_MP_PUBLIC_KEY=<public-key>` num `.env` na raiz do repo (ou `export` no shell) antes do `docker compose --profile full up -d --build` (vai como build arg, ver `docker-compose.yml`'s `web.build.args` e `apps/web/Dockerfile`).

Com isso, pagar com um [cartão de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards) já funciona em `localhost`: pagamento aprovado na resposta síncrona confirma o ingresso na hora. Pagamento recusado mantém a reserva pendente e dá pra tentar de novo até o prazo da reserva (10 min).

#### Rodando com ngrok (webhook do Mercado Pago)

O webhook (`POST /payments/webhook`) só importa pra status que mudam **depois** da resposta síncrona (pagamento em análise, estorno etc.). Ele é server-to-server: o Mercado Pago chama o `notification_url` montado a partir do `PUBLIC_API_URL` configurado **no momento em que o pagamento foi criado** — por isso precisa de URL pública (https), e um pagamento criado antes de trocar a URL nunca recebe o callback. Pra testar o fluxo completo pela URL pública, front e API rodam cada um no seu túnel.

1. **Sobe os dois túneis**, numa janela que você deixa aberta:
   ```bash
   make expose   # ngrok start --all --config ngrok.yml
   ```
   Um único agente ngrok (free tier só permite uma sessão simultânea) expondo os dois túneis de [`ngrok.yml`](./ngrok.yml): `api` (porta 3000) e `web` (porta 5173). Copia as duas URLs `https://...` que aparecem no terminal.

2. **`apps/api/.env`**:
   ```
   CORS_ORIGIN=http://localhost:5173,<url-do-túnel-web>
   WEB_URL=<url-do-túnel-web>
   PUBLIC_API_URL=<url-do-túnel-api>
   MERCADOPAGO_ACCESS_TOKEN=<access-token-de-teste>
   ```
   - `CORS_ORIGIN` precisa listar a URL do túnel `web` além do `localhost` (separadas por vírgula) — sem isso a API rejeita as chamadas do front aberto pelo ngrok (ver `apps/api/src/cors-options.ts`).
   - `PUBLIC_API_URL` é a URL do túnel `api`: vira o `notification_url` do webhook.
   - `WEB_URL` é a URL do túnel `web`. Ficou no `.env.example` desde o Checkout Pro; hoje nenhum código lê ela, mas vale manter alinhada.

3. **`apps/web/.env`**:
   ```
   VITE_API_URL=<url-do-túnel-api>
   VITE_MP_PUBLIC_KEY=<public-key-de-teste>
   ```
   - `VITE_API_URL` aponta pro túnel `api` — senão o front, servido pela URL pública, continua chamando `http://localhost:3000` e o Chrome bloqueia (Private Network Access: origem pública não acessa endereço loopback).
   - `VITE_MP_PUBLIC_KEY` é a Public Key **de teste da mesma aplicação** do Mercado Pago do `MERCADOPAGO_ACCESS_TOKEN` — chave e token de aplicações diferentes geram token de cartão que a API não consegue usar.

4. **Reinicia/rebuilda pra aplicar** (nenhuma dessas variáveis tem hot-reload; `VITE_*` são lidas em build-time):
   - **nativo**: reinicia `pnpm dev:api` e `pnpm dev:web`.
   - **Docker (`make up-full`)**: o build do `web` **não** lê `apps/web/.env` (`.dockerignore` exclui `.env` de todas as imagens, de propósito). Os `VITE_*` entram como build args vindos de um `.env` **na raiz do repo** (lido automaticamente pelo `docker compose`, já está no `.gitignore`) ou do shell (`export VITE_API_URL=...`; no PowerShell, `$env:VITE_API_URL="..."`):
     ```
     # .env na raiz do repo
     VITE_API_URL=<url-do-túnel-api>
     VITE_MP_PUBLIC_KEY=<public-key-de-teste>
     ```
     Depois rebuilda o `web` e recria o `api` (o `api` lê `apps/api/.env` via `env_file` só ao criar o container; `--force-recreate` garante que ele pegue os valores novos):
     ```bash
     docker compose --profile full up -d --build web
     docker compose --profile full up -d --force-recreate api
     ```

5. **Abre o front pela URL do túnel `web`** e faz uma **compra nova** — pagamentos criados antes ficaram com o `notification_url` antigo.

As URLs do free tier mudam a cada vez que o `make expose` reinicia: repete os passos 2 a 5 com as URLs novas.

O free tier do ngrok mostra uma página intermediária ("Visit Site") na primeira navegação pra cada túnel. As chamadas que o front faz pra API (fetch/WebSocket) já mandam o header `ngrok-skip-browser-warning` automaticamente (`apiFetch` em `apps/web/src/lib/api-client.ts`). Pra não precisar clicar em "Visit Site" navegando no browser:

- **DevTools (sem extensão)**: F12 → menu ⋮ → More tools → **Network conditions** → desmarca "Use browser default" em User agent → digita qualquer string (ex: `movietickets-dev`). Vale só pra aba com o DevTools aberto.
- **Extensão de header** (ex: [ModHeader](https://chromewebstore.google.com/detail/modheader/idgpnmonknjnojddfkpgkljpfnnfcklj)): configura pra mandar `ngrok-skip-browser-warning: true` em toda requisição.

## Análise de código (CI)

- **CodeQL** (`.github/workflows/codeql.yml`): SAST, analisa o código do repo (javascript-typescript) atrás de padrão vulnerável. Roda em push/PR pra `main` e semanalmente.
- **Trivy** (`.github/workflows/trivy.yml`): SCA, escaneia `pnpm-lock.yaml` atrás de dependência com CVE conhecida (CRITICAL/HIGH). Roda em push/PR pra `main` e semanalmente.

Ambos publicam resultado na aba **Security → Code scanning** do repo no GitHub. Não travam o merge por padrão — pra exigir isso, ativar "Require code scanning results" no branch ruleset da `main` depois de ter alertas o suficiente pra calibrar o threshold.
