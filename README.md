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
- **[ngrok](https://ngrok.com/)** — só necessário pra receber o webhook do Mercado Pago localmente e acessar o app por URL pública (ver [Rodando com ngrok](#rodando-com-ngrok-webhook-e-acesso-por-url-pública)); pagar com cartão de teste funciona sem ele. Precisa de conta (free tier serve); exporte o authtoken como `NGROK_AUTHTOKEN` no shell (pega em https://dashboard.ngrok.com/get-started/your-authtoken) — **não** `ngrok config add-authtoken`, que salva na config default do ngrok e é ignorado quando `make expose` passa `--config ngrok.yml` (o ngrok não faz merge dos dois arquivos).

## Subir o ambiente local

### macOS / Linux

Tudo funciona nativo, sem passo extra — `make`, `docker`/`podman` e `pnpm` já rodam direto no terminal.

Os dois comandos essenciais:

```bash
make install    # pnpm install
make up-full     # infra + api + web + Drizzle Studio, containerizado
```

A `api` (buildada de `apps/api/Dockerfile`) já aplica as migrations e popula o banco com dados de teste sozinha no boot (idempotente — seguro rodar de novo a cada restart do container). O `web` (buildado de `apps/web/Dockerfile`) é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (interface pra ver/editar o banco) em `http://localhost:4983`, [Mailpit](https://github.com/axllent/mailpit) (caixa de e-mail fake, onde chega o e-mail de confirmação de compra) em `http://localhost:8025`, login de teste: `cliente@movietickets.dev` / `password123` (ou `admin@movietickets.dev` pro papel de admin e a área `/admin`, ou `cliente2@movietickets.dev` pra testar com dois usuários ao mesmo tempo — ver `apps/api/README.md`). Pra derrubar: `make down-full`.

Pra pagar no checkout, configure as credenciais de teste do Mercado Pago antes de subir (ver [Configurar Mercado Pago](#configurar-mercado-pago-sandbox)).

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

A `api` já aplica as migrations e popula o banco sozinha no boot (idempotente), o `web` é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) em `http://localhost:4983`, Mailpit em `http://localhost:8025`, login de teste: `cliente@movietickets.dev` / `password123` (usuários de teste completos em `apps/api/README.md`). Pra derrubar: `docker compose --profile full down`. Pra pagar no checkout, ver [Configurar Mercado Pago](#configurar-mercado-pago-sandbox).

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

## Configurar Mercado Pago (sandbox)

O checkout usa o **Checkout Transparente**: o front monta os campos de cartão com o SDK JS do Mercado Pago (que precisa da **Public Key**) e gera um token; a API cria o pagamento na Payments API com esse token (usando o **Access Token**). Sem as duas credenciais o pagamento não funciona — o resto do app (catálogo, assentos, login, admin) roda sem elas.

### Passo a passo

1. **Pegue as credenciais de teste da aplicação**: [painel do Mercado Pago](https://www.mercadopago.com.br/developers/panel/app) → **Suas integrações** → sua aplicação → **Testes** → **Credenciais de teste**. Use a Public Key e o Access Token **dessa tela** (começam com `TEST-`), os dois da **mesma aplicação**.
2. **Preencha as variáveis** (copie dos `.env.example`: `cp apps/api/.env.example apps/api/.env`, `cp apps/web/.env.example apps/web/.env`, `cp .env.example .env`):

   | Variável | Arquivo | Valor | Quem usa |
   |---|---|---|---|
   | `MERCADOPAGO_ACCESS_TOKEN` | `apps/api/.env` | Access Token de teste (`TEST-...`) | API — cria o pagamento (nativo e Docker, via `env_file`) |
   | `VITE_MP_PUBLIC_KEY` | `apps/web/.env` | Public Key de teste (`TEST-...`) | front rodando com `pnpm dev:web` |
   | `VITE_MP_PUBLIC_KEY` | `.env` (raiz do repo) | a mesma Public Key | front no Docker (`make up-full`): o `docker compose` lê o `.env` da raiz e passa como build arg pra imagem do `web` (o `apps/web/.env` não entra na imagem) |

3. **Aplique** (as variáveis só são lidas na subida/build):
   - nativo: reinicie `pnpm dev:api` e `pnpm dev:web`;
   - Docker, depois de mudar `VITE_*` (`.env` da raiz): `docker compose --profile full up -d --build web`;
   - Docker, depois de mudar `apps/api/.env`: `docker compose --profile full up -d --force-recreate --no-deps api`.
4. **Pague com cartão de teste** (dados publicados pelo Mercado Pago):

   | Campo | Valor |
   |---|---|
   | Número | `5031 4332 1540 6351` (Mastercard) |
   | Código de segurança | `123` |
   | Validade | `11/30` |
   | CPF | `12345678909` |
   | Nome do titular | `APRO` → aprovado · `OTHE` → recusado |

   Outros resultados (em análise, saldo insuficiente etc.) em [Cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards). Com credenciais `TEST-` qualquer e-mail de pagador serve (os usuários do seed funcionam). Pagamento aprovado confirma o ingresso na hora; recusado mantém a reserva pendente e dá pra tentar de novo até o prazo da reserva (10 min).

### Problemas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| Console do browser: `MercadoPago.js - Your public_key cannot be empty`, campos de cartão não aparecem | `VITE_MP_PUBLIC_KEY` vazia quando o front subiu/buildou | Preencher no arquivo certo (`apps/web/.env` nativo, `.env` da raiz no Docker) e reiniciar `pnpm dev:web` / rebuildar o `web` |
| Pagar responde `422 PAYMENT_REQUEST_INVALID`; no log da API o Mercado Pago devolve 401 `Unauthorized use of live credentials` (code 7) | Access Token não é de teste: credencial `APP_USR-` de um usuário vendedor de teste ou credencial de produção | Usar o Access Token `TEST-` da tela **Credenciais de teste** da aplicação (e a Public Key da mesma aplicação), depois recriar o `api` |
| Pagamento falha logo depois de trocar só uma das credenciais | Public Key e Access Token de aplicações diferentes | Pegar as duas da mesma aplicação |
| Erro de CORS no console / chamadas pra API bloqueadas | A origem da página (ex: túnel `web` do ngrok) não está em `CORS_ORIGIN`, ou `VITE_API_URL` aponta pro túnel errado (ou ainda pra `localhost` com a página aberta pela URL pública) | `CORS_ORIGIN` com `localhost` + URL do túnel `web`; `VITE_API_URL` = URL do túnel `api`; recriar o `api` e rebuildar/reiniciar o `web` |

### Rodando com ngrok (webhook e acesso por URL pública)

Só é necessário pra receber o webhook do Mercado Pago (`POST /payments/webhook`, usado em status que mudam depois da resposta síncrona: em análise, estorno) ou abrir o app de fora da máquina. O Mercado Pago chama o `notification_url` montado com o `PUBLIC_API_URL` **do momento em que o pagamento foi criado**, então pagamento criado antes de trocar a URL nunca recebe o callback.

1. `make expose` (deixe a janela aberta) — um agente ngrok com os dois túneis de [`ngrok.yml`](./ngrok.yml): `api` → porta 3000 e `web` → porta 5173. Copie as duas URLs `https://...`.
2. Qual túnel vai em qual variável:

   | Variável | Arquivo | Valor |
   |---|---|---|
   | `PUBLIC_API_URL` | `apps/api/.env` | túnel `api` (vira o `notification_url` do webhook) |
   | `CORS_ORIGIN` | `apps/api/.env` | `http://localhost:5173,<túnel-web>` |
   | `VITE_API_URL` | `apps/web/.env` (nativo) e `.env` da raiz (Docker) | túnel `api` |

   `WEB_URL` (em `apps/api/.env`) sobrou do Checkout Pro e nenhum código lê hoje — não precisa mexer.
3. Aplique como no passo 3 acima (recriar `api`, rebuildar/reiniciar `web`), abra o front pela URL do túnel `web` e faça uma **compra nova**.
4. As URLs do free tier **mudam a cada reinício do `make expose`**: repita os passos 2 e 3.

O free tier mostra uma página "Visit Site" na primeira navegação de cada túnel. As chamadas do front pra API já mandam o header `ngrok-skip-browser-warning` (`apiFetch` em `apps/web/src/lib/api-client.ts`); pra pular a página no browser, troque o User agent (DevTools → More tools → **Network conditions**) ou use uma extensão de header (ex: [ModHeader](https://chromewebstore.google.com/detail/modheader/idgpnmonknjnojddfkpgkljpfnnfcklj)) mandando `ngrok-skip-browser-warning: true`.

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

## Análise de código (CI)

- **CodeQL** (`.github/workflows/codeql.yml`): SAST, analisa o código do repo (javascript-typescript) atrás de padrão vulnerável. Roda em push/PR pra `main` e semanalmente.
- **Trivy** (`.github/workflows/trivy.yml`): SCA, escaneia `pnpm-lock.yaml` atrás de dependência com CVE conhecida (CRITICAL/HIGH). Roda em push/PR pra `main` e semanalmente.

Ambos publicam resultado na aba **Security → Code scanning** do repo no GitHub. Não travam o merge por padrão — pra exigir isso, ativar "Require code scanning results" no branch ruleset da `main` depois de ter alertas o suficiente pra calibrar o threshold.
