# movietickets

Site simplificado de venda de ingressos de cinema (estilo ingresso.com), com foco em seleção de assento sem double-booking.

Monorepo (pnpm workspaces):

- `apps/web` — front (React + Vite). Ver `apps/web/README.md`.
- `apps/api` — back (NestJS). Ver `apps/api/README.md`.
- `docs/` — documentação: `docs/planning.md` (decisões de stack/arquitetura), `docs/c4/` (diagramas C4), `docs/flows/<feature>/` (sequência/classe por feature).

## Subir o ambiente local

Via `make` (ver todos os comandos com `make help`):

```bash
make install          # pnpm install
make up                # Postgres + Valkey (docker compose)
make migrate           # aplica migrations no Postgres local
make seed              # popula usuários de teste
make dev-api            # apps/api
make dev-web             # apps/web
```

Ou direto com pnpm/docker, sem o Makefile:

```bash
docker compose up -d   # Postgres + Valkey
pnpm install
pnpm dev:api            # apps/api
pnpm dev:web             # apps/web
```

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
