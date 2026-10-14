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
- **[ngrok](https://ngrok.com/)** — só necessário pra testar o checkout do Mercado Pago localmente (ver seção abaixo). Precisa de conta (free tier serve); exporte o authtoken como `NGROK_AUTHTOKEN` no shell (pega em https://dashboard.ngrok.com/get-started/your-authtoken) — **não** `ngrok config add-authtoken`, que salva na config default do ngrok e é ignorado quando `make expose` passa `--config ngrok.yml` (o ngrok não faz merge dos dois arquivos).

## Subir o ambiente local

### macOS / Linux

Tudo funciona nativo, sem passo extra — `make`, `docker`/`podman` e `pnpm` já rodam direto no terminal.

Os dois comandos essenciais:

```bash
make install    # pnpm install
make up-full     # infra + api + web + Drizzle Studio, containerizado
```

A `api` (buildada de `apps/api/Dockerfile`) já aplica as migrations e popula o banco com dados de teste sozinha no boot (idempotente — seguro rodar de novo a cada restart do container). O `web` (buildado de `apps/web/Dockerfile`) é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (interface pra ver/editar o banco) em `http://localhost:4983`, login de teste: `cliente@movietickets.dev` / `password123` (ou `admin@movietickets.dev` pro papel de admin, ou `cliente2@movietickets.dev` pra testar com dois usuários ao mesmo tempo — ver `apps/api/README.md`). Pra derrubar: `make down-full`.

Ou por partes, rodando cada app localmente com hot reload em vez de containerizado:

```bash
make install          # pnpm install
make up                # Postgres + Valkey (docker compose)
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

A `api` já aplica as migrations e popula o banco sozinha no boot (idempotente), o `web` é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) em `http://localhost:4983`, login de teste: `cliente@movietickets.dev` / `password123` (usuários de teste completos em `apps/api/README.md`). Pra derrubar: `docker compose --profile full down`.

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
make test-integration   # integração, contra Postgres local

# ou:
pnpm test        # unitários + integração, todos os apps
pnpm test:e2e
```

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

### Testando o checkout do Mercado Pago localmente (ngrok)

O fluxo de pagamento (`PaymentModule`) chama a Preferences API do Mercado Pago, que precisa de uma URL pública (https) tanto pro webhook de confirmação (`notification_url`) quanto pro `back_url` de retorno do checkout — por isso essa seção usa um túnel [ngrok](https://ngrok.com/) em vez de `localhost`. O webhook é server-to-server: o Mercado Pago chama direto o `PUBLIC_API_URL` que estava configurado **no momento em que o checkout foi criado** — se o túnel cair/mudar depois disso, aquele checkout específico nunca recebe o callback, precisa criar um novo.

Ordem pra testar (repete a partir do passo 2 toda vez que reiniciar o `make expose`, já que o free tier gera URLs novas a cada sessão):

1. **Sobe o túnel**, numa janela que você deixa aberta:
   ```bash
   make expose   # ngrok start --all --config ngrok.yml
   ```
   Um único agente ngrok (free tier só permite uma sessão simultânea) expondo os dois túneis de [`ngrok.yml`](./ngrok.yml): `web` (porta 5173) e `api` (porta 3000). Copia as duas URLs que aparecem no terminal.

2. **Atualiza `apps/api/.env`** com a URL do túnel `api`:
   ```
   WEB_URL=<url-do-túnel-web>
   PUBLIC_API_URL=<url-do-túnel-api>
   CORS_ORIGIN=http://localhost:5173,<url-do-túnel-web>
   ```
   `CORS_ORIGIN` precisa incluir a URL do `web` explicitamente — sem isso a API rejeita as chamadas cross-origin do front hospedado no ngrok (ver `apps/api/src/cors-options.ts`).

3. **Manda a URL do túnel `api` pro front também** — senão ele, já servido pela URL pública do `web`, continua chamando `http://localhost:3000` direto, e o Chrome bloqueia isso (Private Network Access: origem pública não acessa endereço loopback). `VITE_API_URL` é lida em build-time pelo Vite (não tem hot-reload), e **onde** ela entra depende de como você sobe o front:
   - **`pnpm dev:web` (nativo)**: `apps/web/.env` → `VITE_API_URL=<url-do-túnel-api>`.
   - **`make up-full` (containerizado)**: `apps/web/.env` é ignorado no build (`.dockerignore` exclui `.env` de todas as imagens, de propósito) — `export VITE_API_URL=<url-do-túnel-api>` no shell antes do próximo passo em vez disso (vai como build arg pro `vite build` dentro do container; ver `docker-compose.yml`'s `web.build.args` e `apps/web/Dockerfile`).

4. **Reinicia/rebuilda pra aplicar**:
   - **nativo**: reinicia `pnpm dev:api` e `pnpm dev:web` (nenhum dos dois tem hot-reload pra essas env vars).
   - **containerizado**: `docker compose --profile full up -d --build` (o `--build` é essencial pro `web` pegar o `VITE_API_URL` novo; o `api` só precisa recriar, mas rebuildar os dois junto não tem custo real).

5. **Abre o front pela própria URL do ngrok do `web`, não por `localhost`.** Se você comprar o ingresso acessando `http://localhost:5173`, o Mercado Pago redireciona de volta através do domínio do ngrok (`WEB_URL`) — um domínio diferente do `localhost` onde você estava logado. Esse é exatamente o motivo da rota `/checkout/retorno` ser pública (ver `apps/web/src/App.tsx`): o browser não leva `localStorage`/sessão de um domínio pro outro. Começando a sessão já pela URL do ngrok, front e back_url ficam no mesmo domínio o tempo todo e o login não some.

6. **Faz uma compra nova** — não reusa um booking/checkout criado antes do passo 2, porque o webhook URL dele já ficou fixado com a URL antiga.

O free tier do ngrok mostra uma página intermediária ("Visit Site") na primeira navegação pra cada túnel — isso é esperado, só clicar pra seguir. As chamadas que o front faz pra API (fetch/WebSocket) já mandam o header `ngrok-skip-browser-warning` automaticamente (`apiFetch` em `apps/web/src/lib/api-client.ts`), então essas não ficam travadas atrás dessa página. Pra não precisar clicar em "Visit Site" a cada navegação manual no browser também (a página intermediária só some com esse mesmo header, um User-Agent não padrão, ou conta paga do ngrok — nenhum dos quais a address bar manda sozinha):

- **DevTools (sem extensão)**: F12 → menu ⋮ → More tools → **Network conditions** → desmarca "Use browser default" em User agent → digita qualquer string (ex: `movietickets-dev`). Vale só pra aba com o DevTools aberto.
- **Extensão de header** (ex: [ModHeader](https://chromewebstore.google.com/detail/modheader/idgpnmonknjnojddfkpgkljpfnnfcklj)): configura pra mandar `ngrok-skip-browser-warning: true` em toda requisição — mais prático testando em várias abas sem reabrir o DevTools.

## Análise de código (CI)

- **CodeQL** (`.github/workflows/codeql.yml`): SAST, analisa o código do repo (javascript-typescript) atrás de padrão vulnerável. Roda em push/PR pra `main` e semanalmente.
- **Trivy** (`.github/workflows/trivy.yml`): SCA, escaneia `pnpm-lock.yaml` atrás de dependência com CVE conhecida (CRITICAL/HIGH). Roda em push/PR pra `main` e semanalmente.

Ambos publicam resultado na aba **Security → Code scanning** do repo no GitHub. Não travam o merge por padrão — pra exigir isso, ativar "Require code scanning results" no branch ruleset da `main` depois de ter alertas o suficiente pra calibrar o threshold.
