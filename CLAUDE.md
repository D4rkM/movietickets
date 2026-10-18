# movietickets

Monorepo (pnpm workspaces): `apps/web` (React + Vite), `apps/api` (NestJS), `docs/` (C4, planning, per-feature flow diagrams).

Referência de decisões de arquitetura e stack: `docs/planning.md`. Diagramas macro: `docs/c4/` (`.drawio`, abrir em app.diagrams.net). Diagramas de sequência/classe por feature: `docs/flows/<feature>/`.

Esse arquivo é a referência única de regras pra qualquer agente de IA no repo. `AGENTS.md` aponta pra cá — existe só pra ferramentas (Codex, Cursor, Aider etc.) que procuram esse nome por padrão em vez de `CLAUDE.md`.

## Regra permanente: spec-driven development (SDD manual)

Toda feature nova começa com uma spec escrita antes do código: `docs/flows/<feature>/spec.md`, com critérios de aceitação numerados (`AC1`, `AC2`, ...). Sem framework dedicado (spec-kit etc.) — segue a convenção manual já existente em `docs/flows/<feature>/` (mesma pasta de `sequence.md`/`class.md`).

- Mapeamento é só por feature/spec — spec não referencia card de board (Notion/Jira/etc.) por nome ou ID. O card aponta pra spec, nunca o contrário.
- Teste de integração/e2e que valida uma AC referencia o número dela no título do `it` (ex: `AC2`), pra regressão na esteira apontar direto pra regra de negócio quebrada.

## Regra permanente: testes

Toda feature nova precisa vir com teste unitário. Se envolver fluxo entre camadas (API+banco, API+cache/Valkey, seat hold/booking), precisa também de teste de integração. Não considerar uma feature pronta sem isso — sem exceção, mesmo pra mudanças pequenas.

- Front (`apps/web`): Vitest + React Testing Library.
- Back (`apps/api`): Jest (padrão NestJS), testes de integração batendo em Postgres/Valkey reais (docker-compose ou testcontainers).

### Padrão de escrita dos testes

- **Teste unitário**: nome do `it` sempre em inglês, `it("should ...")`, descrevendo o comportamento esperado. Comentários 3A dentro do corpo — `// ARRANGE`, `// ACT`, `// ASSERT`. Testa uma função/classe isolada, faz sentido pensar em passos. `it.each` é bem-vindo aqui pra variações de input/output da mesma função.
- **Teste de integração/e2e**: nome do `it` em português, descrevendo a regra de negócio da spec (ex: `it("AC2: deve bloquear o segundo usuário de segurar um assento já ocupado")`) — não `"should ..."` em inglês. Objetivo é o teste servir de documentação viva, legível por quem não lê código (PO, time de produto). Comentários Given/When/Then — `// GIVEN`, `// WHEN`, `// THEN`. Testa um comportamento fim a fim (dado um estado, quando uma ação ocorre, então tal resultado), mais natural que 3A pra esse tipo de teste.
  - **Sem `it.each`** nesse nível, mesmo que fique repetitivo — parametrizar esconde qual regra especificamente quebrou quando a esteira falha, e complica o helper de suporte com condicionais pra cada variação. Um `it` declarativo por cenário.
  - Lógica repetitiva de setup/chamada/asserção (ex: montar request, bater no Supertest, checar shape de resposta) fica isolada em helpers (`test/helpers/*.ts`) — o corpo do `it` só orquestra chamadas de helper com nomes que leem como a spec, não `supertest` cru.

## Regra permanente: comentários em código

Todo comentário de código (`//`, `/* */`, JSDoc) sempre em inglês, independente da linguagem do código ou da conversa. Nomes de variável/função também seguem inglês (padrão já usado no projeto). Documentação solta (`docs/`, `README.md`, mensagens de commit) continua em português.

## Regra permanente: branch + PR

Nunca commitar direto em `main`. Todo ajuste (feature, fix, chore, docs) segue este fluxo:

1. Criar branch nova a partir de `main` atualizada: `git checkout main && git pull && git checkout -b <tipo>/<descrição-curta>` — mesmo prefixo do Conventional Commits (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`), descrição curta em kebab-case (ex: `feat/seat-map-endpoint`).
2. Commitar o trabalho na branch (respeitando os hooks de pre-commit/commit-msg).
3. Push da branch e abrir PR no GitHub via `gh pr create`, com título e corpo descrevendo a mudança.
4. Nunca dar merge automático — o PR fica aberto pra revisão humana.

Sem exceção mesmo pra mudanças pequenas (docs, config) — mantém `main` sempre passível de review antes de entrar.

## Regra permanente: instalar lib nova

Toda dependência instalada (`pnpm add`) fica com versão exata no `package.json`, sem `^`/`~` — o `.npmrc` (`save-exact=true`) já faz isso por padrão, mas vale checar depois de instalar. Se a lib tiver script de build/postinstall (não é o caso comum), precisa entrar na allowlist `pnpm.onlyBuiltDependencies` do `package.json` raiz, senão o script fica bloqueado silenciosamente.

## Arquitetura

- Sem event sourcing completo. CQRS "light": commands/queries separados por módulo Nest, sem event store.
- Assento: consistência forte via Postgres (constraint única `session_id + seat_id` + transação). Valkey só pra hold temporário (TTL) durante checkout, não é fonte de verdade definitiva.
- Comunicação front↔back: REST por padrão. Não trocar pra GraphQL sem necessidade concreta identificada.
