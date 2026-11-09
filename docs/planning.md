# Plano: Site de venda de ingressos de cinema (estilo ingresso.com simplificado)

## Contexto

Projeto novo (sem código existente). Objetivo: clone simplificado do ingresso.com, com foco especial em fazer a **seleção de assento funcionar bem** (sem double-booking, com feedback em tempo real), mais 4 outras features core pro MVP. Stack definida: React+Vite (front), NestJS+Node (back), Postgres (banco principal). Decisão de arquitetura: **sem event sourcing completo** — complexidade e eventual consistency não valem a pena pro caso de assento, que exige forte consistência. Usa-se CQRS "light" (separação de commands/queries nos módulos Nest) + Postgres transacional. Valkey entra como peça central do mecanismo de "seat hold" temporário (lock com TTL) enquanto usuário está no checkout. O plano inicial previa também cache de catálogo no Valkey, mas isso não foi implementado: `GET /movies` lê direto do Postgres.

## Stack

- **Front:** React + Vite
- **Back:** NestJS (Node) — módulos separados por domínio, commands/queries separados (CQRS light, sem event store)
- **Banco:** PostgreSQL — relacional, pois assento precisa de constraint única + transação (evita double-booking; NoSQL exigiria trabalho extra pra garantir isso)
- **Cache/Lock:** Valkey — seat hold temporário (TTL de 10min) durante checkout, índice de holds de convidado e keyspace notifications pra avisar expiração de hold. Cache de catálogo (filmes/sessões) foi previsto no plano inicial mas **não existe hoje**; se entrar, toda escrita do painel admin precisa invalidar as chaves (regra em `docs/flows/admin-panel/spec.md`)
- **Pagamento:** Mercado Pago (sandbox) — Checkout Transparente com Core Methods: o front tokeniza o cartão com o SDK JS do Mercado Pago (campos seguros) e a API cria o pagamento direto na Payments API. O Checkout Pro (Preferences API + redirect) foi removido
- **Comunicação front↔back:** REST no início. Revisar pra GraphQL (ou outro) só se aparecer necessidade concreta (ex.: over-fetching no mapa de assentos, múltiplos consumidores com necessidades diferentes) — não trocar de forma especulativa.
- **Real-time (recomendado):** WebSocket via Nest Gateway (Socket.io) — broadcast de mudanças no mapa de assentos (held/released/booked) pra todos usuários vendo a mesma sessão. Sem isso, mapa de assento fica "stale" e usuário tenta escolher assento já pego — prejudica exatamente a feature que precisa funcionar bem.
- **E-mail:** notificação de confirmação de compra, via `nodemailer` (SMTP). Dev local usa [Mailpit](https://github.com/axllent/mailpit) (serviço `mailpit` do `docker-compose.yml`, sobe junto com `make up`) — SMTP fake na porta 1025 + UI web em `http://localhost:8025`, e-mail nunca sai da rede local. Provedor real de produção (SES, SendGrid etc.) fica em aberto, decide quando o projeto for pra produção de verdade.
- **Testes e2e (front):** [Playwright](https://playwright.dev/) (`apps/web/e2e/`, `pnpm --filter web test:e2e`) — sobe o browser de verdade batendo num backend real (Postgres + Valkey, mesmo setup usado pelos testes de integração do back), validando fluxo completo (não só componente isolado). Complementa os `*.e2e-spec.ts` do back (`apps/api/test/`, real Postgres/Valkey/WebSocket) e o Vitest + RTL do front (unitário/componente). Casos que só fazem sentido com browser real: duas abas vendo o mapa de assento atualizar via WebSocket, hold expirando de verdade, concorrência de clique em assento.

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

Estrutura de pastas (estado atual):
```
movietickets/                    (raiz do monorepo)
├── apps/
│   ├── web/                     (React + Vite)
│   │   ├── src/features/        (admin, auth, catalog, checkout, seating, tickets)
│   │   ├── e2e/                 (Playwright)
│   │   └── README.md            (papel do front, como rodar/testar)
│   └── api/                     (NestJS)
│       ├── src/                 (um módulo Nest por pasta: admin, auth, booking, catalog, notification, payment, seating + db, valkey)
│       ├── drizzle/             (migrations SQL geradas pelo drizzle-kit)
│       ├── test/                (testes de integração/e2e, *.e2e-spec.ts)
│       └── README.md            (papel do back, como rodar/testar)
├── docs/
│   ├── planning.md              (este arquivo)
│   ├── schema.md                (tabelas, colunas, constraints)
│   ├── schema-erd.mmd           (diagrama ER, Mermaid)
│   ├── c4/
│   │   ├── context.drawio       (diagrama C4 Context, referenciado por context.md)
│   │   └── container.drawio     (diagrama C4 Container, referenciado por container.md)
│   ├── bruno/                   (collection do Bruno pra testar a API manualmente)
│   └── flows/                   (por feature: spec.md + sequence.md quando houver)
│       ├── TEMPLATE.spec.md
│       ├── admin-panel/
│       ├── booking/
│       ├── checkout-transparente/
│       ├── pending-booking-expiry/
│       └── public-catalog-login-gate/
├── docker-compose.yml           (Postgres + Valkey + Mailpit; profile `full` sobe api + web + Drizzle Studio)
├── Makefile                     (atalhos, `make help`)
├── pnpm-workspace.yaml
├── package.json                 (raiz)
├── .github/workflows/
│   ├── web-ci.yml               (lint + testes unitários + e2e Playwright do front)
│   ├── api-ci.yml               (lint + testes unitários + integração do back, sobe Postgres/Valkey como services)
│   ├── codeql.yml / trivy.yml   (SAST e SCA)
│   └── claude*.yml              (automação de review)
├── CLAUDE.md                    (regras do projeto — ver abaixo)
└── README.md                    (raiz — visão geral, como subir tudo)
```

Cada feature nova ganha `docs/flows/<feature>/spec.md` antes do código (SDD manual, ver `CLAUDE.md`) e, quando o fluxo justificar, `sequence.md`/`class.md` (Mermaid) na mesma pasta.

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
- `Booking`/`Order` (pedido: User + Session + lista de Seats + status: pending/confirmed/cancelled/expired; `pending` tem prazo `expires_at`)
- `Payment` (uma linha por tentativa de pagamento do pedido: status do Mercado Pago + payment_id externo) e `PaymentEvent` (histórico append-only de auditoria dos pagamentos)
- `User` (conta: nome, email, senha hash)

Constraint crítica: unique `(session_id, seat_id)` em tabela de assentos ocupados/reservados — garante que dois pedidos nunca fecham o mesmo assento na mesma sessão.

Definição completa de colunas, tipos, PK/FK e a tabela de junção `booking_seats` (onde essa constraint realmente mora): `docs/schema.md`.

## Features / Stories (6 no total)

### 1. Seleção de assento (core, prioridade máxima)
- Mapa visual de assentos por sessão (livre / ocupado / segurado-por-outro-usuário / selecionado-por-mim) — **implementado**
- Ao confirmar pagamento: transação Postgres grava assento como ocupado definitivamente (respeitando unique constraint) — **implementado**
- Ao clicar assento: cria hold no Valkey (`SETNX` com TTL) — evita dois usuários segurando mesmo assento — **implementado** (back + front: `SessionSeatsPage` segura/solta ao clicar via `POST`/`DELETE /sessions/:id/seats/:seatId/hold`)
- Visitante deslogado também segura assento: hold com identidade de convidado (`POST /auth/guest`, JWT `kind: guest` de 2h), mesma regra do usuário logado (`SETNX` + TTL 600s, máx. 6 por sessão). No login (`guestToken` opcional, uso único), os holds são transferidos pro usuário mantendo o TTL; se passar de 6 na mesma sessão, ficam os do convidado e saem os holds mais antigos do usuário — **implementado** (milestone AC3, spec `docs/flows/public-catalog-login-gate/spec.md`, PRs #66 e #70)
- WebSocket broadcast pros outros clientes na mesma sessão quando assento muda de estado — **implementado no back** (`SeatingGateway`, room por sessão, eventos held/released/booked; front `useSeatingSocket` com `socket.io-client` atualiza o `SeatMap`)
- Ao expirar TTL sem confirmar checkout, ou ao cliente cancelar: hold libera (automático ou manual), assento volta a ficar livre (evento broadcast), e remove o hold do Valkey na confirmação — **implementado no back** (TTL do Valkey + `HoldExpiryListener` via keyspace notifications + liberação manual/bulk) e no front (desmarcar assento solta o hold; sair do checkout chama `DELETE /sessions/:id/holds`)

### 2. Catálogo — busca/listagem de filmes e sessões
- Lista de filmes em cartaz com sessões futuras — **implementado**
- Filtro por cidade/cinema/data (query params em `GET /movies`) — **implementado** (front: selects de cidade/cinema e campo de data no `MoviesPage`)
- Detalhe do filme com horários disponíveis (sessões) — **implementado** (embutido na listagem)
- Catálogo e mapa de assentos públicos (sem login), como página de apresentação do site — **implementado** (milestone AC3, spec `docs/flows/public-catalog-login-gate/spec.md`, PRs #66 e #70)

### 3. Checkout / pagamento (Mercado Pago sandbox)
- Resumo do pedido (filme, sessão, assentos, valor) — **implementado**
- Reserva atômica multi-assento numa transação só — **implementado**. A confirmação mockada (`POST /bookings/:id/confirm`, sem gateway) continua no back pra teste manual/e2e, mas o front não usa mais
- Checkout Transparente com Core Methods (formulário próprio no front; número, validade e CVV em campos seguros do SDK JS do Mercado Pago, `@mercadopago/sdk-js`; `GET /bookings/:id/payment-summary` e `POST /bookings/:id/payments` no back, Payments API direta com `X-Idempotency-Key` = id da tentativa (`attemptId`) gerado pelo cliente) — **implementado (sandbox)** (milestone AC3, spec `docs/flows/checkout-transparente/spec.md`, PRs #64, #77 e #75). Substituiu o Checkout Pro (Preferences API / `init_point`), removido junto com `POST /bookings/:id/checkout`, `back_urls`/`auto_return` e a rota `/checkout/retorno`. Cada tentativa vira uma linha em `payments` e eventos em `payment_events` (append-only, trigger no banco). Pagamento aprovado na resposta síncrona já confirma o booking. Pix fica fora desta etapa
- Webhook de confirmação de pagamento (`POST /payments/webhook`) → re-busca o pagamento na API do MP (status nunca vem do corpo da notificação), atualiza a tentativa em `payments`, grava `webhook_received` em `payment_events` e confirma o `Booking` se `approved` (idempotente, mesmo caminho da resposta síncrona) — **implementado (sandbox)**. Webhook só é necessário pra status que mudam depois da resposta síncrona (análise, estorno); ambiente local precisa de URL pública (tunnel) pra o MP conseguir chamá-lo
- Falha/timeout de pagamento — **implementado** (milestone AC3, specs `docs/flows/pending-booking-expiry/spec.md` e `docs/flows/checkout-transparente/spec.md`, PRs #69, #71, #72, #77 e #75):
  - pagamento `rejected`/`cancelled` (na resposta síncrona ou no webhook) só grava o status da tentativa: o booking continua `pending` e o cliente pode tentar de novo (novo `attemptId`) até o `expires_at` (10 min após a reserva). MP recusando a requisição (4xx) → `422 PAYMENT_REQUEST_INVALID`; MP sem resposta → `504 PAYMENT_PROVIDER_TIMEOUT` (reenviar o mesmo `attemptId` é seguro); outra tentativa em andamento → `409 PAYMENT_IN_PROGRESS`
  - booking `pending` vencido sem pagamento em andamento (`pending`/`in_process`) vira `expired` e libera os assentos (broadcast `released` via WebSocket): via job periódico (`PendingBookingSweeper`, `@nestjs/schedule`, a cada 60s) e de forma lazy nas leituras/escritas (regra única em `booking-lock.ts`). Pagamento em andamento segura o booking além do prazo; se passar de 24h, o sweeper registra um alerta uma vez (`stale_payment_alerted_at`)
  - pagamento `approved` que chega num booking já `expired` não ressuscita a reserva: marca `needs_refund_review` pra estorno manual
  - o checkout exibe aviso de reserva expirada (`409 BOOKING_EXPIRED`) com retorno ao mapa de assentos; voltar ao checkout com reserva pendente pros mesmos assentos retoma ela (`409 BOOKING_ALREADY_PENDING` com o `bookingId`)

### 4. Conta de usuário + histórico de ingressos
- Cadastro/login (JWT) — **implementado**
- Login exigido só ao avançar pro pagamento (catálogo e assentos são públicos; token de convidado recusado com 401 em booking, pagamento e ingressos) — **implementado** (milestone AC3, spec `docs/flows/public-catalog-login-gate/spec.md`, PRs #66 e #70)
- "Meus ingressos": lista de bookings confirmados, com detalhe — **implementado**
- Cancelamento de ingresso pelo cliente (self-service), libera o(s) assento(s) de volta pro catálogo — **implementado no back** (`POST /bookings/:id/cancel`, broadcast released) e no front (botão "Cancelar" com confirmação no `TicketsPage`)
- QR code simples — opcional/fora do MVP

### 5. Painel admin
- CRUD de filmes, cinemas, salas e sessões (`/admin/*` na API, área `/admin` no front)
- Sem necessidade de UI sofisticada — formulários simples, protegido por role admin
- **Status: implementado (milestone AC3)** — spec `docs/flows/admin-panel/spec.md` (PR #68), back (PR #73: `@Roles`/`RolesGuard`, CRUD de filmes/cinemas/salas/sessões com regras de sobreposição e edição de sessão) e front (PR #76: área `/admin`). Não há cache de catálogo pra invalidar (ver Stack)

### 6. Notificação por e-mail
- Confirmação de compra por e-mail quando o `Booking` é confirmado
- Dev local via Mailpit (ver seção Stack) — sem depender de provedor real
- Hoje já existe envio **síncrono e best-effort**: `NotificationService` (`nodemailer`) manda o e-mail depois do commit da confirmação (resposta síncrona do pagamento, webhook ou confirmação mockada); falha de SMTP só gera log, não desfaz a confirmação
- Envio assíncrono por worker, com tabela `notifications`; mecanismo do worker (outbox + polling vs outbox + BullMQ) ainda em aberto
- **Status da versão assíncrona: não iniciada** — última entrega do **milestone AC3**; spec em review (PR #63, `docs/flows/notification/spec.md`, ainda fora da `main`)

## Arquitetura de módulos (NestJS)

- `CatalogModule` — queries de filmes/sessões (`GET /movies`, público), direto no Postgres (sem cache)
- `SeatingModule` — commands (hold, release, release all) + queries (seat map), Valkey lock + WebSocket Gateway (`/seating`); `HoldExpiryListener` (keyspace notifications) e `HoldTransferService` (transfere holds de convidado no login). Rotas aceitam token de usuário ou de convidado (`UserOrGuestAuthGuard`)
- `BookingModule` — commands (criar booking, confirmar, cancelar, confirmar booking pago), transação Postgres; regra de trava/expiração em `booking-lock.ts` e `PendingBookingSweeper` (`@nestjs/schedule`, `@Interval` de 60s, `FOR UPDATE SKIP LOCKED`, seguro com várias instâncias)
- `PaymentModule` — Checkout Transparente: resumo do pagamento, criação de tentativa na Payments API do Mercado Pago, webhook handler e auditoria em `payment_events`
- `AuthModule` — cadastro/login (JWT com `kind`: `user` ou `guest`), token de convidado (`POST /auth/guest`, rate limit via `@nestjs/throttler`), `JwtAuthGuard` (só usuário), `UserOrGuestAuthGuard`, `@Roles`/`RolesGuard`
- `AdminModule` — CRUD filmes/cinemas/salas/sessões em `/admin/*` (role `admin`), com services de command/query próprios por recurso (não reusa o `CatalogModule`)
- `NotificationModule` — envio de e-mail de confirmação de compra (`nodemailer`, Mailpit em dev), chamado pelo `BookingModule` depois do commit da confirmação (síncrono, best-effort)

## Verificação end-to-end

1. Subir Postgres + Valkey (docker-compose)
2. Rodar back NestJS e front Vite localmente
3. Fluxo manual: listar filmes → escolher sessão → abrir mapa de assento → selecionar assento (confirmar hold aparece pros outros via segunda aba/browser) → login (holds de convidado transferidos) → checkout → pagamento com cartão de teste do Mercado Pago (Checkout Transparente) → confirmar → ver ingresso em "Meus ingressos"
4. Testar concorrência: duas abas tentando segurar o mesmo assento simultaneamente — só uma deve conseguir
5. Testar expiração de hold: segurar assento e não finalizar checkout, esperar TTL — assento deve voltar a ficar livre pros outros
6. Testar painel admin: criar filme/sessão nova, verificar que aparece no catálogo na hora
7. Testar expiração de reserva: criar reserva no checkout e não pagar por 10 min — booking vira `expired` e os assentos voltam a ficar livres
