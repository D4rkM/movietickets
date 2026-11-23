# Roteiro de testes manuais (QA)

Checklist pra validar o produto de ponta a ponta pelo navegador, do catálogo ao pagamento e ao painel admin. Serve pra QA, PO ou dev.

## 1. Objetivo e quando usar

Confirmar que os fluxos de usuário funcionam juntos no ambiente real (front + API + Postgres + Valkey + Mercado Pago sandbox), coisa que os testes automatizados cobrem só em partes.

Rodar o roteiro inteiro:

- antes de fechar um milestone ou release (ex: entrega "Prova");
- depois de mudança em fluxo de pagamento, reserva/expiração, hold de assento ou login;
- depois de atualizar SDK/credenciais do Mercado Pago ou a configuração de ambiente.

Pra mudança pequena e localizada, basta a seção afetada.

## 2. Pré-requisitos

**Ambiente**

- Ambiente rodando: README, seção [Subir o ambiente local](../../README.md#subir-o-ambiente-local). Front em `http://localhost:5173`, API em `http://localhost:3000`, Mailpit (e-mails) em `http://localhost:8025`, Drizzle Studio (banco) em `http://localhost:4983`.
- Migrations aplicadas e seed rodado. No `make up-full` a API faz isso sozinha no boot; rodando por partes, `make migrate` + `make seed`.
- Credenciais de teste do Mercado Pago: README, seção [Configurar Mercado Pago (sandbox)](../../README.md#configurar-mercado-pago-sandbox).
- **Com monitoramento** (seção 3.10): `make up-full-obs` (stack completa + Grafana). Grafana em `http://localhost:3001` (`admin`/`admin`). Detalhes no README, seção [Observabilidade](../../README.md#observabilidade).
  - A VM do Podman precisa de **pelo menos 4 GiB de RAM** e algum disco livre pra imagem do Grafana (~1 GB). Já faltou memória/disco aqui e o `lgtm` não subiu: conferir antes de começar (`podman machine inspect`; ajustar com `podman machine set --memory 4096` com a VM parada).
- Só pra seção 3.7 (webhook) e 3.9 (conferir estorno no Mercado Pago): túneis ngrok, README, seção [Rodando com ngrok](../../README.md#rodando-com-ngrok-webhook-e-acesso-por-url-pública). Ver o checklist de URLs abaixo.

**`ENABLE_TEST_ROUTES=true` (só quando o item pedir)**

`POST /bookings/:id/confirm` (confirmação sem pagamento) responde 404 a menos que a API rode com `ENABLE_TEST_ROUTES=true` (spec `docs/flows/test-routes/spec.md`, AC1/AC2). Precisam dela: a collection Bruno, o e2e do front, o cenário `booking_cancel` do teste de carga (3.11) e o item "cancelar sem pagamento" da 3.4. **O checkout normal com Mercado Pago não precisa.** Pra ligar: `ENABLE_TEST_ROUTES=true` em `apps/api/.env` e recriar a API (`docker compose --profile full up -d --force-recreate --no-deps api`). Desligar depois.

**Checklist ao trocar a URL do ngrok**

As URLs do free tier mudam a cada reinício do `make expose`. Toda vez que mudarem:

1. `PUBLIC_API_URL` (`apps/api/.env`) = túnel da API (vira o `notification_url` do webhook; pagamento criado antes da troca nunca recebe callback).
2. `CORS_ORIGIN` (`apps/api/.env`) = `http://localhost:5173,<túnel-web>,<túnel-api>`: tem que ter **os dois** túneis (web e API), senão o front dá erro de CORS.
3. `WEB_URL` (`apps/api/.env`): atualizar também, por consistência (o README diz que nenhum código lê hoje).
4. `VITE_API_URL` = túnel da API, em `apps/web/.env` (nativo) e no `.env` da raiz (Docker). É variável de build do Vite: **exige rebuild** do `web` (`docker compose --profile full up -d --build web`).
5. Recriar a API pra ler o `.env` (`docker compose --profile full up -d --force-recreate --no-deps api`).
6. Abrir o front pela URL do túnel web e fazer uma compra **nova**.

Stack subida a partir de um **git worktree** não enxerga os `.env` do checkout principal (estão no `.gitignore`): copiar `.env`, `apps/api/.env` e `apps/web/.env` pro worktree antes de subir.

**Dois usuários ao mesmo tempo**

O login fica no `localStorage`, que é compartilhado entre abas do mesmo navegador. Pra ter dois usuários (ou convidado + usuário) lado a lado, usar uma janela normal e uma **janela anônima** (ou dois navegadores/perfis). Onde o roteiro diz "outra aba", é nesse sentido.

**Usuários de teste (seed)**

| E-mail | Papel |
|---|---|
| `cliente@movietickets.dev` | cliente |
| `cliente2@movietickets.dev` | cliente (segundo usuário) |
| `admin@movietickets.dev` | admin |

Senha: `password123` (constante `DEV_PASSWORD` em `apps/api/src/db/seed.ts`; o seed também imprime no terminal).

**Cartão de teste do Mercado Pago** (público, da página [Cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards))

| Campo | Valor |
|---|---|
| Número | Mastercard `5031 4332 1540 6351` |
| CVV | `123` |
| Validade | `11/30` |
| CPF | `12345678909` |
| Nome do titular | `APRO` → aprovado · `OTHE` → recusado |

## 3. Roteiro

Formato: `- [ ] ação → resultado esperado`. Marcar cada item ao validar.

### 3.1 Catálogo e login com convidado

Spec: `docs/flows/public-catalog-login-gate/spec.md` (AC1, AC3, AC5, AC6, AC7, AC8, AC13, AC15)

Começar deslogado (janela anônima nova).

- [ ] Abrir `/movies` sem login → lista de filmes com sessões futuras, sem redirecionar pro login.
- [ ] Abrir `/tickets` ou `/checkout` direto, sem login → redireciona pra `/login`.
- [ ] Clicar numa sessão e em 2 assentos livres → os 2 ficam marcados como seus; botão mostra "Continuar (2 assentos)".
- [ ] Recarregar a página → os mesmos 2 assentos continuam selecionados.
- [ ] Clicar em "Continuar (2 assentos)" → vai pra `/login`.
- [ ] Logar com `cliente@movietickets.dev` → volta pro mapa da mesma sessão com os 2 assentos como seus.
- [ ] (Opcional, limite) Em outra janela, `cliente@` logado segura 2 assentos na mesma sessão. Na janela anônima, convidado segura 6 outros e loga como `cliente@` → aviso "Alguns assentos não ficaram com você:" listando os 2 mais antigos com "liberado para respeitar o limite de 6 assentos por sessão"; ficam 6 selecionados.
- [ ] (Opcional, hold expirado) Como convidado, segurar assentos e esperar mais de 10 min antes de logar → após o login, aviso listando esses assentos com "o tempo de reserva acabou antes do login", e eles saem da seleção.

### 3.2 Tempo real em duas abas

Spec: `docs/flows/public-catalog-login-gate/spec.md` (AC12). Fluxo base sem spec própria (anterior ao SDD): `docs/flows/booking/sequence.md`.

Janela A com `cliente@`, janela B com `cliente2@`, as duas no mapa da mesma sessão.

- [ ] Em A, segurar um assento → em B ele aparece ocupado na hora, sem recarregar.
- [ ] Em B, tentar clicar nesse assento → não fica com B.
- [ ] Em A, soltar o assento (clicar de novo) → em B ele volta a livre na hora.

### 3.3 Checkout transparente

Spec: `docs/flows/checkout-transparente/spec.md` (AC2, AC3, AC4, AC6, AC7, AC9, AC18)

Logado como `cliente@`, com 1 ou 2 assentos seguros.

- [ ] Clicar em "Continuar (N assentos)" e depois em "Continuar para pagamento" → reserva criada, aparece o formulário de pagamento.
- [ ] Digitar número, validade e CVV → campos aceitam digitação; aparece "Bandeira: ..." e o select de "Parcelas" é carregado.
- [ ] Clicar em "Pagar" com nome vazio ou CPF inválido → mensagem em pt-BR no campo ("CPF inválido." etc.), sem enviar pagamento.
- [ ] Recarregar a página antes de pagar → retoma a mesma reserva na etapa de pagamento (não pede pra reservar de novo nem dá conflito).
- [ ] Pagar com titular `OTHE` → "Pagamento recusado. Confira os dados ou use outro cartão."; continua no checkout.
- [ ] Na mesma reserva, pagar com titular `APRO` → tela "Pagamento aprovado!" com "Ver meus ingressos".
- [ ] Abrir o Mailpit → chegou o e-mail de confirmação da compra.
- [ ] Em outra janela no mapa da sessão → os assentos pagos aparecem ocupados.

### 3.4 Ingressos e cancelamento (com estorno)

Spec: `docs/flows/refund/spec.md` (AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10, AC11, AC27, AC28, AC29, AC31, AC33). Sequência: `docs/flows/refund/sequence.md`.

Pré-condição: compra paga com titular `APRO` na 3.3 (sessão com início daqui a **mais de 2 h**; o seed gera sessões assim, senão criar uma na 3.6). Anotar o id do pagamento (tabela `payments`, coluna `external_payment_id`, no Drizzle Studio) pra conferir na 3.9.

Cancelamento com estorno (cliente):

- [ ] Menu de perfil → "Ver ingressos" → "Meus ingressos" mostra o ingresso pago (filme, horário, cinema, sala, assentos, total) com o botão "Cancelar".
- [ ] Clicar em "Cancelar" → diálogo mostra o **valor total** do ingresso, diz que o estorno é **integral no cartão usado na compra** e traz a data/hora limite (2 h antes da sessão).
- [ ] Confirmar ("Sim, cancelar") → o ingresso **continua na lista**, esmaecido (dados de filme/sessão/assentos/total com opacidade reduzida), com o selo "Estorno em andamento" ou "Estorno concluído" e o aviso "Ingresso cancelado. Estorno em andamento." / "Ingresso cancelado e estornado.", legível (o aviso não fica esmaecido). Sem botão "Cancelar" nesse ingresso.
- [ ] Um ingresso ativo (outro, não cancelado) continua sem esmaecer.
- [ ] Mailpit → chegou o e-mail de estorno solicitado ao dono da compra, com filme, sessão, assentos e valor.
- [ ] Abrir o mapa da sessão → os assentos do ingresso cancelado estão livres.
- [ ] Como `cliente2@` (outra janela), reservar um desses assentos → conseguiu (sem erro 409).
- [ ] Verificar o estorno no Mercado Pago (seção 3.9) → pagamento com status `refunded`.

Prazo vencido:

- [ ] Ingresso de sessão que começa em 2 h ou menos (criar sessão na 3.6 e comprar, ou ajustar `starts_at` no Drizzle Studio) → não aparece o botão "Cancelar"; aparece "Cancelamento encerrado (até 2 horas antes da sessão)".

Repetição e falhas:

- [ ] Clicar duas vezes rápido em "Sim, cancelar" no diálogo → um único estorno (conferir uma só linha em `refunds` no Drizzle Studio); a segunda chamada não gera erro nem outro estorno.
- [ ] Recarregar "Meus ingressos" depois de cancelado → o ingresso continua lá, cancelado, sem botão "Cancelar" (cancelar de novo não é possível pela tela).
- [ ] (Opcional, falha) Com `MERCADOPAGO_ACCESS_TOKEN` inválido na API (recriar o container, **restaurar depois**), cancelar → mensagem de erro do back no diálogo; o ingresso continua ativo, com os assentos, e dá pra tentar de novo. Em timeout, a mensagem aparece e o botão vira "Tentar de novo".
- [ ] Reserva `pending` ou `expirada` sem estorno não aparece em "Meus ingressos" (não há o que cancelar). Tentar cancelar uma reserva não confirmada pela API (Bruno) → 409 `BOOKING_NOT_CANCELLABLE`.

Cancelamento sem pagamento (precisa de `ENABLE_TEST_ROUTES=true`):

- [ ] Criar reserva, confirmar sem pagar (`POST /bookings/:id/confirm`, Bruno "Confirm booking") e cancelar pela API (`POST /bookings/:id/cancel`) → responde `refund: null`, assentos liberados, **nenhuma chamada ao Mercado Pago** (sem linha em `refunds`) e a reserva **não aparece** em "Meus ingressos". Sem a flag, a confirmação responde 404 (spec test-routes, AC1).

### 3.5 Expiração de reserva

Spec: `docs/flows/pending-booking-expiry/spec.md` (AC2, AC3, AC8, AC16, AC17) e `docs/flows/checkout-transparente/spec.md` (AC21)

Janela A com `cliente@`, janela B com `cliente2@` no mapa da mesma sessão.

- [ ] Em A, segurar um assento, clicar em "Continuar para pagamento" e parar no formulário → em B o assento aparece ocupado.
- [ ] Esperar ~10–11 min (prazo de 10 min + até 1 min do job de expiração) sem pagar → em B o assento volta a livre sozinho, sem recarregar.
- [ ] Em A, tentar pagar essa reserva vencida → "Sua reserva expirou. Escolha os assentos novamente." com o botão "Escolher assentos".
- [ ] Clicar em "Escolher assentos" → volta pro mapa da sessão.

### 3.6 Painel admin

Spec: `docs/flows/admin-panel/spec.md` (AC7, AC9, AC12, AC14, AC21, AC22, AC23, AC24, AC25)

- [ ] Logado como `cliente@`, abrir `/admin` → "Acesso restrito"; o menu de perfil não tem o link "Admin".
- [ ] Logado como `admin@` → o menu de perfil tem o link "Admin", que abre o painel.
- [ ] Filmes → "Novo filme" → preencher e "Salvar" → filme aparece na lista.
- [ ] Salas → "Nova sala" (cinema do seed, 5 fileiras, 8 assentos por fileira) → "Salvar" → sala aparece na lista.
- [ ] Sessões → "Nova sessão" com o filme e a sala novos, início futuro (horário de São Paulo) e preço → "Salvar" → sessão aparece na lista com o mesmo horário digitado.
- [ ] Abrir `/movies` → o filme novo aparece com essa sessão.
- [ ] Criar outra sessão na mesma sala com horário que se sobrepõe à anterior → erro no formulário; os valores digitados continuam preenchidos.
- [ ] Abrir o mapa da sessão nova → layout A1–E8 (5 fileiras × 8), todos livres.
- [ ] Filmes → "Excluir" no filme que tem sessão → confirmar → erro na página; o filme continua na lista.

### 3.7 Webhook (opcional)

Spec: `docs/flows/checkout-transparente/spec.md` (AC9, AC25)

Precisa dos túneis ngrok, com `PUBLIC_API_URL` apontando pro túnel da API (ver pré-requisitos).

- [ ] Abrir o front pela URL do túnel web e fazer uma compra **nova** com titular `APRO` → "Pagamento aprovado!".
- [ ] `docker compose logs api` (ou o terminal do `pnpm dev:api`) → aparece `POST /payments/webhook` com status 200, e a reserva não é confirmada duas vezes (um e-mail só no Mailpit).

### 3.8 Fila de estornos do admin

Spec: `docs/flows/refund/spec.md` (AC20, AC21, AC22, AC30). Fila em `/admin/refunds`.

Reserva pra revisão não se forma facilmente pela UI: forçar assim.

1. Como `cliente@`, pagar uma reserva com titular `APRO` (3.3) e anotar o id da reserva.
2. No Drizzle Studio (`http://localhost:4983`), tabela `bookings`, nessa reserva: `status = expired` e `needs_refund_review = true`. Salvar.

- [ ] Logado como `cliente@`, abrir `/admin/refunds` → "Acesso restrito" (sem acesso).
- [ ] Logado como `admin@`, abrir `/admin/refunds` → a reserva aparece na fila com filme, sessão, e-mail do cliente, valor e motivo "Pagamento aprovado em reserva expirada".
- [ ] Clicar em "Estornar" → pede confirmação; confirmar → a fila recarrega e a reserva sai da fila (`needs_refund_review = false`; a reserva continua `expired`). Se o estorno ficou em andamento, o botão vira "Atualizar status".
- [ ] Clicar em "Atualizar status" (quando aparecer) → re-busca o pagamento no Mercado Pago e atualiza a linha, sem criar estorno novo.
- [ ] Conferir o estorno no Mercado Pago (3.9) e o e-mail no Mailpit (estorno aceito envia e-mail ao dono da reserva).
- [ ] Erro (ex: API sem token válido do Mercado Pago) → a página mostra a mensagem do back; a reserva permanece na fila.

### 3.9 Conferir o estorno no Mercado Pago

Pagamentos do sandbox (`live_mode: false`) **não aparecem** em "Atividades" da conta real do Mercado Pago. Conferir por:

- [ ] API: `curl -s -H "Authorization: Bearer $MERCADOPAGO_ACCESS_TOKEN" https://api.mercadopago.com/v1/payments/<id>` com o **Access Token de teste** (nunca colar o token em relato, print ou terminal compartilhado). `<id>` = `payments.external_payment_id` (Drizzle Studio). Esperado após estorno total: `status: refunded` e `refunds` com 1 item.
- [ ] Painel de desenvolvedor da aplicação de teste → Webhooks → histórico de notificações: aparece a notificação do pagamento (só chega se os túneis estiverem de pé, 3.7).
- [ ] Inspetor do ngrok `http://localhost:4040`: requisições `POST /payments/webhook` com status 200.
- [ ] Webhook de estorno feito **direto no painel do Mercado Pago** (não pela aplicação) → reserva `confirmed` vira `cancelled`, assentos liberados e linha `refunds` com `reason = external`. **Não verificado**: nunca foi testado em sandbox (comportamento só descrito na spec, AC17). Registrar o resultado na tabela final.

### 3.10 Monitoramento (Grafana)

Spec: `docs/flows/observability/spec.md` (dashboards, métricas `movietickets.*`, alertas, D5). Precisa de `make up-full-obs` (a API exporta pro Grafana). Dashboards e alertas vêm do PR #92 e ficam provisionados em `infra/observability/`.

- [ ] Abrir `http://localhost:3001` (`admin`/`admin`) → pasta "MovieTickets" com 4 dashboards: APM, Runtime, Dependências e Negócio.
- [ ] Gerar tráfego: navegar no catálogo, segurar/soltar assento, criar reserva, pagar com `APRO` e cancelar (estorno). Esperar ~1 min (a API exporta métricas a cada 15 s).
- [ ] APM → requisições por rota, latência p50/p95/p99 e % de 5xx aparecem; clicar num exemplar de latência abre o trace no Tempo.
- [ ] Runtime → event loop, heap, GC e conexões WebSocket com dados.
- [ ] Dependências → Postgres, Valkey e Mercado Pago com taxa e latência.
- [ ] Negócio → holds criados/liberados, reservas criadas/confirmadas/canceladas, pagamentos por status e estornos refletem o que foi feito acima. No Explore (Prometheus), conferir `movietickets_seat_hold_created_total`, `movietickets_booking_created_total`, `movietickets_booking_confirmed_total`, `movietickets_booking_cancelled_total` subindo.
- [ ] Explore (Tempo) → trace de `POST /bookings/:id/cancel`, com spans do Postgres, do Valkey e da chamada ao Mercado Pago (`api.mercadopago.com`).
- [ ] No trace, abrir os logs relacionados (Loki) → logs com `trace_id`, na mesma requisição.
- [ ] Logs e spans **não contêm IP nem user agent** do cliente: buscar no Loki por `remoteAddress` e `user-agent` e em atributos do trace por `client.address`/`user_agent.original` → nada.
- [ ] Alerta: provocar (ex: pagar várias vezes com `OTHE` até passar de 50% de recusa com ao menos 5 pagamentos em 15 min, ou parar a API por 5 min pro alerta "Sweeper parado") → em Alerting o alerta passa a Firing e chega e-mail do Grafana no Mailpit. Alertas existentes: taxa de 5xx, latência p95, pico de pagamento recusado, pagamento parado > 24 h, sweeper parado.

### 3.11 Teste de carga (k6)

Spec: `docs/flows/load-test/spec.md` (AC1, AC3, AC4, AC5). Detalhes e variáveis em `load/README.md` (PR #93). Precisa do `k6` instalado (`brew install k6`) e da stack local rodando (`make up-full` ou `make up-full-obs`). Não rodar durante teste manual na mesma stack: o `make load` escreve no banco.

- [ ] `make load-smoke` → só leitura (1 VU, 1 iteração, cenário `browse`), termina sem erro e sem criar usuário/hold/reserva. Sem o `k6` instalado, falha com mensagem clara.
- [ ] `make load` → termina com thresholds aprovados. Na disputa por assento (`seat_contention`), **exatamente 1 vencedor** (`200`) e os demais `409`.
- [ ] O cenário `booking_cancel` só roda com `ENABLE_TEST_ROUTES=true` na API; sem a flag é pulado com aviso (não reprova).
- [ ] Com `make up-full-obs`, os dashboards APM e Negócio mostram o tráfego da carga.
- [ ] Sobras esperadas: usuários `load-*@loadtest.local` no banco e reservas `cancelled` (limpeza opcional em `load/README.md`).

## 4. Como reportar um problema

Abrir o relato com:

- **Passo**: seção e item do roteiro (ex: 3.3, "pagar com titular `OTHE`").
- **O que apareceu na tela**: texto exato ou print.
- **Console do navegador**: erros da aba Console do DevTools.
- **Rede**: request e response da chamada que falhou (aba Network: URL, método, status, corpo da resposta).
- **Horário** em que aconteceu, pra cruzar com os logs da API (`docker compose logs api`).

Nunca colar no relato token de acesso, Access Token/Public Key do Mercado Pago ou URL de túnel.

## 5. Manter este roteiro

Toda feature nova com fluxo de usuário adiciona sua seção aqui, junto com a spec, apontando pras ACs que ela cobre.

## 6. Resultado da validação

Preencher ao rodar o roteiro. Status: OK, Falhou, Pulado ou Não verificado.

| Seção | Status | Notas (versão/commit, data, quem testou, link do relato) |
|---|---|---|
| 3.1 Catálogo e login com convidado | | |
| 3.2 Tempo real em duas abas | | |
| 3.3 Checkout transparente | | |
| 3.4 Ingressos e cancelamento (estorno) | | |
| 3.5 Expiração de reserva | | |
| 3.6 Painel admin | | |
| 3.7 Webhook (opcional) | | |
| 3.8 Fila de estornos do admin | | |
| 3.9 Conferir estorno no Mercado Pago (inclui webhook de estorno externo, não verificado) | | |
| 3.10 Monitoramento (Grafana) | | |
| 3.11 Teste de carga (k6) | | |
