# movietickets

Site de venda de ingressos de cinema, com foco em seleção de assento sem double-booking.

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

## Subir o ambiente local

### macOS / Linux

Tudo funciona nativo, sem passo extra — `make`, `docker`/`podman` e `pnpm` já rodam direto no terminal.

Os dois comandos essenciais:

```bash
make install    # pnpm install
make up-full     # infra + api + web + Drizzle Studio, containerizado
```

A `api` (buildada de `apps/api/Dockerfile`) já aplica as migrations e popula o banco com dados de teste sozinha no boot (idempotente — seguro rodar de novo a cada restart do container). O `web` (buildado de `apps/web/Dockerfile`) é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (interface pra ver/editar o banco) em `http://localhost:4983`, login de teste: `cliente@movietickets.dev` / `password123` (ou `admin@movietickets.dev` pro papel de admin). Pra derrubar: `make down-full`.

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

A `api` já aplica as migrations e popula o banco sozinha no boot (idempotente), o `web` é servido via `vite preview`. Front em `http://localhost:5173`, API em `http://localhost:3000`, [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) em `http://localhost:4983`, login de teste: `cliente@movietickets.dev` / `password123`. Pra derrubar: `docker compose --profile full down`.

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

## Análise de código (CI)

- **CodeQL** (`.github/workflows/codeql.yml`): SAST, analisa o código do repo (javascript-typescript) atrás de padrão vulnerável. Roda em push/PR pra `main` e semanalmente.
- **Trivy** (`.github/workflows/trivy.yml`): SCA, escaneia `pnpm-lock.yaml` atrás de dependência com CVE conhecida (CRITICAL/HIGH). Roda em push/PR pra `main` e semanalmente.

Ambos publicam resultado na aba **Security → Code scanning** do repo no GitHub. Não travam o merge por padrão — pra exigir isso, ativar "Require code scanning results" no branch ruleset da `main` depois de ter alertas o suficiente pra calibrar o threshold.
