# Plano: Site de venda de ingressos de cinema (estilo ingresso.com simplificado)

## Contexto

Projeto novo (sem código existente). Objetivo: clone simplificado do ingresso.com, com foco especial em fazer a **seleção de assento funcionar bem** (sem double-booking, com feedback em tempo real), mais 4 outras features core pro MVP. Stack definida: React+Vite (front), NestJS+Node (back), Postgres (banco principal). Decisão de arquitetura: **sem event sourcing completo** — complexidade e eventual consistency não valem a pena pro caso de assento, que exige forte consistência. Usa-se CQRS "light" (separação de commands/queries nos módulos Nest) + Postgres transacional. Valkey entra como peça central: cache de catálogo E mecanismo de "seat hold" temporário (lock com TTL) enquanto usuário está no checkout.

## Stack

- **Front:** React + Vite
- **Back:** NestJS (Node) — módulos separados por domínio, commands/queries separados (CQRS light, sem event store)
- **Banco:** PostgreSQL — relacional, pois assento precisa de constraint única + transação (evita double-booking; NoSQL exigiria trabalho extra pra garantir isso)
- **Cache/Lock:** Valkey — dois usos: (1) cache de catálogo (filmes/sessões, leitura pesada e pouco mutável), (2) seat hold temporário (TTL ~5-10min) durante checkout
- **Pagamento:** Mercado Pago (sandbox) — ambiente de teste, comum em projeto BR
- **Comunicação front↔back:** REST no início. Revisar pra GraphQL (ou outro) só se aparecer necessidade concreta (ex.: over-fetching no mapa de assentos, múltiplos consumidores com necessidades diferentes) — não trocar de forma especulativa.
- **Real-time (recomendado):** WebSocket via Nest Gateway (Socket.io) — broadcast de mudanças no mapa de assentos (held/released/booked) pra todos usuários vendo a mesma sessão. Sem isso, mapa de assento fica "stale" e usuário tenta escolher assento já pego — prejudica exatamente a feature que precisa funcionar bem.
- **E-mail:** notificação de confirmação de compra, via `nodemailer` (SMTP). Dev local usa [Mailpit](https://github.com/axllent/mailpit) (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`) — SMTP fake + UI web em `http://localhost:8025`, e-mail nunca sai da rede local. Provedor real de produção (SES, SendGrid etc.) fica em aberto, decide quando o projeto for pra produção de verdade.
- **Testes e2e (front):** [Playwright](https://playwright.dev/) — entra junto com o começo do código de front. Sobe o browser de verdade batendo num backend real (Postgres + Valkey, mesmo setup usado pelos testes de integração do back), validando fluxo completo (não só componente isolado). Hoje o back já tem essa camada (`*.e2e-spec.ts` em `apps/api/test/`, real Postgres/Valkey/WebSocket); o front até agora só tinha Vitest + RTL (unitário/componente), sem nada cobrindo o fluxo fim a fim pelo navegador — é essa lacuna que o Playwright fecha. Casos que só fazem sentido com browser real: duas abas vendo o mapa de assento atualizar via WebSocket, hold expirando de verdade, concorrência de clique em assento.

## Localização e escopo desta primeira execução

Projeto criado em `~/projects/movietickets`. **Esta primeira execução é só scaffold + documentação macro** — não escreve código de feature ainda (isso vem depois, feature por feature, junto com os diagramas de sequência/classe de cada uma). Escopo desta etapa:
1. Estrutura de pastas do monorepo (`apps/web`, `apps/api`, `docs/`)
2. `docs/c4/context.drawio` e `docs/c4/container.drawio` com os diagramas C4 (shapes oficiais, abrir em app.diagrams.net), referenciados por `docs/c4/context.md`/`container.md`
3. `docs/planning.md` — cópia deste plano inicial (stack, arquitetura, features, decisões tomadas nesta conversa), como referência pra desenvolver as próximas features
4. Arquivos de config base: `pnpm-workspace.yaml`, `package.json` raiz, `docker-compose.yml` (Postgres + Valkey), `.github/workflows/*.yml` (esqueleto), `CLAUDE.md` (regra de testes), `README.md` raiz + READMEs vazios/esqueleto em `apps/web` e `apps/api`
5. `git init` + primeiro commit

Sequência/classe diagrams por feature (`docs/flows/<feature>/sequence.md`, `docs/flows/<feature>/class.md`) e o código real de cada app ficam pra próximas rodadas, uma feature por vez.

## Organização do projeto (monorepo)

- **1 repositório GitHub** (monorepo) com pasta principal contendo `/apps/web` (front) e `/apps/api` (back) — decisão: mudanças de contrato de API (ex.: payload do mapa de assentos) ficam no mesmo commit/PR, CI mais simples de coordenar, sem overhead de sincronizar 2 repos pra um projeto desse porte.
- **pnpm workspaces** pra gerenciar os 2 pacotes (web/api) a partir da raiz.

Estrutura de pastas:
```
movietickets/                    (raiz do monorepo, ~/projects/movietickets)
├── apps/
│   ├── web/                     (React + Vite)
│   │   └── README.md            (papel do front, como rodar/testar)
│   └── api/                     (NestJS)
│       └── README.md            (papel do back, como rodar/testar)
├── docs/
│   ├── c4/
│   │   ├── context.drawio       (diagrama C4 Context, referenciado por context.md)
│   │   └── container.drawio     (diagrama C4 Container, referenciado por container.md)
│   └── flows/                   (por feature, preenchido conforme desenvolvimento)
│       ├── seat-selection/
│       ├── catalog/
│       ├── checkout-payment/
│       ├── user-account/
│       └── admin-catalog/
├── docker-compose.yml           (Postgres + Valkey pra dev local)
├── pnpm-workspace.yaml
├── package.json                 (raiz)
├── .github/workflows/
│   ├── web-ci.yml               (lint + testes unitários + integração do front)
│   └── api-ci.yml               (lint + testes unitários + integração do back, sobe Postgres/Valkey como services)
├── CLAUDE.md                    (regras do projeto — ver abaixo)
└── README.md                    (raiz — visão geral, papel de cada app, como subir tudo via docker-compose)
```

Cada pasta em `docs/flows/<feature>/` vai ganhar `sequence.md` e `class.md` (Mermaid) quando aquela feature for desenvolvida — não são criados todos de uma vez.

### Testes (obrigatório, sempre)
- **Front:** testes unitários (Vitest + React Testing Library) por componente/hook, e testes de integração de componentes/fluxos mockando API. Fluxos críticos (seleção de assento com concorrência/WebSocket real, checkout completo) ganham também teste **e2e com Playwright**, batendo num backend real — não dá pra validar "duas abas veem a mudança em tempo real" só com API mockada.
- **Back:** testes unitários (Jest, padrão NestJS) por service/handler, e testes de integração batendo em Postgres/Valkey reais (via docker-compose ou testcontainers) — principalmente pro fluxo de seat hold + booking, onde concorrência importa.
- Isso vai pro `CLAUDE.md` da raiz como regra permanente do projeto, pra não deixar passar durante a implementação: **toda feature nova precisa vir com teste unitário e, quando envolver fluxo entre camadas (API+banco, API+cache), teste de integração também.**

### CI/CD (GitHub Actions)
- Workflow por app (`web-ci.yml`, `api-ci.yml`), disparado em push/PR, com path filters (só roda CI do front quando `apps/web/**` muda, só roda CI do back quando `apps/api/**` muda) — evita rodar suite inteira à toa em monorepo.
- `api-ci.yml` sobe Postgres + Valkey como `services:` do job pra rodar os testes de integração no CI, não só localmente.

### READMEs
- Raiz: visão geral do projeto, papel de cada pasta (`apps/web`, `apps/api`), como subir tudo com `docker-compose up` + `pnpm install` + `pnpm dev`.
- `apps/web/README.md` e `apps/api/README.md`: papel específico do app, como rodar sozinho, como rodar os testes (unitários e integração).

## Modelo de dados (core)

- `Movie` (filme: título, sinopse, duração, poster, classificação)
- `Cinema` (unidade física: nome, endereço, cidade — uma rede pode ter várias unidades, cada uma com suas próprias salas)
- `Room` (sala de cinema: pertence a um Cinema, capacidade, layout de fileiras/colunas)
- `Seat` (assento: pertence a Room, posição fileira/coluna)
- `Session` (sessão/horário: Movie + Room + datetime + preço)
- `Booking`/`Order` (pedido: User + Session + lista de Seats + status: pending/confirmed/cancelled)
- `Payment` (referência ao pedido + status do Mercado Pago + payment_id externo)
- `User` (conta: nome, email, senha hash)

Constraint crítica: unique `(session_id, seat_id)` em tabela de assentos ocupados/reservados — garante que dois pedidos nunca fecham o mesmo assento na mesma sessão.

Definição completa de colunas, tipos, PK/FK e a tabela de junção `booking_seats` (onde essa constraint realmente mora): `docs/schema.md`.

## Features / Stories (6 no total)

### 1. Seleção de assento (core, prioridade máxima)
- Mapa visual de assentos por sessão (livre / ocupado / segurado-por-outro-usuário / selecionado-por-mim) — **implementado**
- Ao confirmar pagamento: transação Postgres grava assento como ocupado definitivamente (respeitando unique constraint) — **implementado**
- Ao clicar assento: cria hold no Valkey (`SETNX` com TTL) — evita dois usuários segurando mesmo assento — **pendente, AC2**
- WebSocket broadcast pros outros clientes na mesma sessão quando assento muda de estado — **pendente, AC2**
- Ao expirar TTL sem confirmar checkout, ou ao cliente cancelar: hold libera (automático ou manual), assento volta a ficar livre (evento broadcast), e remove o hold do Valkey na confirmação — **pendente, AC2**

### 2. Catálogo — busca/listagem de filmes e sessões
- Lista de filmes em cartaz com sessões futuras — **implementado**
- Filtro por cidade/cinema/data (query params em `GET /movies`) — **pendente, AC2**
- Detalhe do filme com horários disponíveis (sessões) — **implementado** (embutido na listagem)

### 3. Checkout / pagamento (Mercado Pago sandbox)
- Resumo do pedido (filme, sessão, assentos, valor) — **implementado**
- Pagamento mockado (sem gateway real), reserva atômica multi-assento numa transação só — **implementado**
- Integração Mercado Pago sandbox de verdade (checkout transparente ou redirect, a definir na implementação) — **pendente, AC2**
- Webhook de confirmação de pagamento → atualiza `Booking` pra `confirmed`, grava assento definitivo — **pendente, AC2**
- Falha/timeout de pagamento → libera hold do assento — depende do hold existir (feature #1)

### 4. Conta de usuário + histórico de ingressos
- Cadastro/login (JWT) — **implementado**
- "Meus ingressos": lista de bookings confirmados, com detalhe — **implementado**
- Cancelamento de ingresso pelo cliente (self-service), libera o(s) assento(s) de volta pro catálogo — **pendente, AC2**
- QR code simples — opcional/fora do MVP

### 5. Painel admin
- CRUD de filmes, salas e sessões
- Sem necessidade de UI sofisticada — formulários simples, protegido por role admin
- **Status: não iniciado**, sem entrega planejada ainda

### 6. Notificação por e-mail
- Confirmação de compra por e-mail quando o `Booking` é confirmado
- Dev local via Mailpit (ver seção Stack) — sem depender de provedor real
- **Status: não iniciado, AC2**

## Arquitetura de módulos (NestJS)

- `CatalogModule` — queries de filmes/sessões, cache Valkey
- `SeatingModule` — commands (HoldSeat, ReleaseSeat) + queries (GetSeatMap), Valkey lock + WebSocket Gateway
- `BookingModule` — commands (CreateBooking, ConfirmBooking, CancelBooking), transação Postgres
- `PaymentModule` — integração Mercado Pago sandbox, webhook handler
- `AuthModule` — login/cadastro, JWT
- `AdminModule` — CRUD filmes/salas/sessões (reusa services do CatalogModule onde fizer sentido)
- `NotificationModule` — envio de e-mail de confirmação de compra (`nodemailer`, Mailpit em dev), disparado pelo `BookingModule` na confirmação

## Verificação end-to-end

1. Subir Postgres + Valkey (docker-compose)
2. Rodar back NestJS e front Vite localmente
3. Fluxo manual: listar filmes → escolher sessão → abrir mapa de assento → selecionar assento (confirmar hold aparece pros outros via segunda aba/browser) → checkout → pagamento sandbox Mercado Pago → confirmar → ver ingresso em "Meus ingressos"
4. Testar concorrência: duas abas tentando segurar o mesmo assento simultaneamente — só uma deve conseguir
5. Testar expiração de hold: segurar assento e não finalizar checkout, esperar TTL — assento deve voltar a ficar livre pros outros
6. Testar painel admin: criar filme/sessão nova, verificar que aparece no catálogo (e cache invalida corretamente)
