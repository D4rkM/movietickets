# Spec: Estorno de pagamento (cancelamento pelo cliente e revisão do admin)

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...) e não têm relação com nenhuma outra numeração externa.
>
> Referências `(Dn)` em ACs e seções apontam pra decisão aprovada correspondente em "Decisões desta spec" → "Decisões aprovadas (D1–D8)".

## Contexto

Hoje o dinheiro nunca volta pro cliente:

- `POST /bookings/:id/cancel` (`BookingConfirmationController` → `BookingService.cancelBooking`, `apps/api/src/booking/booking.service.ts`) aceita só reserva `confirmed` do próprio usuário, vira `cancelled` e emite `seat:update` `released` por assento. Não chama o Mercado Pago, não tem prazo e não grava nada em `payments`/`payment_events`.
- Bug relacionado: `cancelBooking` **não apaga** os `booking_seats`. O mapa mostra o assento `free` (`activeBookingCondition` ignora `cancelled`), mas a constraint única `booking_seats (session_id, seat_id)` continua ocupada, então reservar de novo aquele assento dá 409. Esta spec corrige isso.
- Pagamento `approved` que chega numa reserva `expired` marca `bookings.needs_refund_review = true` e loga `warn` (AC14 de `docs/flows/pending-booking-expiry/spec.md`). Não existe fila nem ação: alguém precisa estornar pelo painel do Mercado Pago.
- O webhook (`PaymentService.handleWebhook`) já grava `refunded`/`charged_back`/`in_mediation` em `payments.status` (a guarda `canTransitionPaymentStatus` permite sair de `approved` pra esses status) e só loga `warn` em `applyPaymentStatus` (AC26 de `docs/flows/checkout-transparente/spec.md`).
- "Meus ingressos" (`GET /bookings/mine`, `TicketsPage`) lista só `confirmed`. Depois de cancelar, o ingresso some da tela sem nenhuma informação sobre dinheiro.

Esta spec liga o cancelamento ao estorno total no Mercado Pago (Refunds API), cria a fila de revisão do admin pras reservas marcadas com `needs_refund_review`, e trata o estorno que chega pelo webhook.

## Escopo

- Estorno **total** de pagamento com cartão aprovado, via `POST /v1/payments/{id}/refunds` com `X-Idempotency-Key`.
- Gatilho 1 (cliente): cancelar reserva `confirmed` paga dispara o estorno, só até um prazo antes do início da sessão.
- Gatilho 2 (admin): estornar reserva marcada com `needs_refund_review`, por endpoint `/admin/*` e uma tela de fila de revisão.
- Tabela nova `refunds` (uma linha por pedido de estorno) e eventos novos em `payment_events`.
- Webhook: `refunded` passa a ter efeito (idempotente, mesmo caminho da resposta síncrona); decisão explícita pra `charged_back`/`in_mediation`.
- Liberação de assento no cancelamento (apaga `booking_seats`, corrige o bug acima) com broadcast `released`.
- "Meus ingressos" mostra ingressos cancelados com o status do estorno.
- E-mail de estorno solicitado, best-effort (reusa o `NotificationService`). (D5)
- Serviço de estorno reutilizável (`RefundService`), pensado pra ser chamado depois pela feature de cancelamento de sessão pelo admin.

## Fora de escopo

- Admin cancelar uma sessão inteira que já vendeu ingresso (soft delete + estorno em lote). Fica pra feature futura separada, que já está prevista em `docs/flows/admin-panel/spec.md` ("Fora de escopo"). O `RefundService` desta spec é a peça que ela vai reusar (motivo `session_cancelled` já reservado, ver "Tabela `refunds`").
- Estorno parcial por assento (cancelar só alguns assentos de uma reserva). (D2)
- Tratamento de contestação/chargeback (disputa, envio de documentação, `in_mediation`). Só registramos o status (ver "Webhook").
- Pix, boleto e qualquer meio que não seja cartão de crédito (o checkout hoje só aceita cartão).
- Cancelar reserva `pending` pelo cliente (continua 409, quem libera é a expiração).
- Estorno de pagamento aprovado há mais de 180 dias (o Mercado Pago recusa; aparece como estorno com falha).
- Job automático que re-tenta estorno parado. A re-tentativa é manual (cliente chama de novo ou admin aciona pela fila).
- Validação de assinatura `x-signature` do webhook (não existe hoje; continua re-buscando o pagamento na API).

## Fatos do Mercado Pago usados (verificados na documentação)

- **Criar reembolso**: `POST /v1/payments/{id}/refunds`. "Se o campo amount estiver preenchido, será criado um reembolso parcial, caso contrário, se criará um reembolso total." Header `X-Idempotency-Key` obrigatório ("permite repetir solicitações de forma segura, sem o risco de realizar a mesma ação mais de uma vez por engano [...] como a criação de dois reembolsos idênticos"; sugere UUID v4). Fonte: https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/create-refund/post
- **Resposta do reembolso**: `id` (número, id do reembolso), `payment_id`, `amount`, `metadata` ("metadados de pagamento que nos são enviados no post de payment", ou seja, o `metadata` do pagamento, não um campo nosso por reembolso), `source`, `date_created`, `unique_sequence_number`, `refund_mode`, `adjustment_amount`, `status`, `reason`. Os valores de `status` listados na referência são os mesmos de pagamento (`approved`, `in_process`, `rejected`, `cancelled`, `authorized`); o exemplo traz `approved`. Mesma fonte, e `GET /v1/payments/{id}/refunds` (https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/get-refunds/get).
- **Erros documentados do `POST .../refunds`** (nomes da referência; o agrupamento por HTTP status na página é ambíguo): `2063` The-action-requested-is-not-valid-for-the-current-payment-state (400), `2085` Invalid-value-for-gateway_operation (400), `401` Invalid-token, `4040`/`4041` amount positivo/numérico, `2000` Payment-not-found, `2024` e `15016` Payment-too-old-to-be-refunded, `3024` Partial refund unsupported for this transaction, `4292` Header-X-Idempotency-Key-can't-be-null, `4296` Charge-already-refunded. Mesma fonte.
- **Status do pagamento depois do estorno** (página de resultados da Payments API): `refunded` / `refunded` = "O pagamento foi devolvido pelo collector"; `refunded` / `by_admin` = "o pagamento foi devolvido"; `approved` / `partially_refunded` = "O pagamento foi feito com pelo menos um reembolso parcial"; `charged_back` / `settled` = "O dinheiro foi retido após um processo de estorno"; `charged_back` / `reimbursed` = "O dinheiro foi devolvido após um processo de estorno"; `charged_back` / `in_process` = "O pagamento está em processo de recuperação pois o pagador desconhece a transação"; `in_mediation` / `pending` = "O pagamento está em processo de mediação ou disputa". Fonte: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/response-handling/query-results
- **Regras gerais de reembolso** (documentadas na página da **Orders API**, não na da Payments API legada que usamos; ver "Fatos não verificados"): prazo de 180 dias a partir da aprovação; cartão de crédito devolve "diretamente na fatura"; "é preciso ter saldo suficiente disponível em sua conta para efetuar a devolução do valor, caso contrário, a transação não será realizada"; reembolso é pra pagamento capturado, cancelamento é pra pagamento não aprovado. Fonte: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/refunds-cancellations
- **SDK Node `mercadopago@3.6.1`** (instalado; lido em `node_modules/mercadopago/dist/clients/paymentRefund/`): classe `PaymentRefund` com `total({ payment_id, requestOptions })` (POST `/v1/payments/{id}/refunds` com corpo `{}`), `create({ payment_id, body: { amount? }, requestOptions })`, `get` e `list`. `RefundResponse` tem `id`, `payment_id`, `amount`, `status`, `amount_refunded_to_payer` etc. `PaymentResponse` (usado no webhook via `Payment.get`) tem `refunds?: RefundResponse[]` e `transaction_amount_refunded`. Mesmo comportamento de retry/idempotência do `Payment.create` (ver checkout spec): `requestOptions.idempotencyKey` vira o header, e os retries internos em 429/5xx reaproveitam a mesma chave.
- **Idempotência**: mesma chave devolve o recurso já criado; com o processamento original ainda em andamento a API responde 409. Fonte já citada na spec de checkout (documentação da Wallet Connect, `.../idempotency/responses`).
- **Webhooks**: a notificação é só um sinal, é preciso buscar o recurso e processar de forma idempotente porque o mesmo evento pode chegar mais de uma vez; responder 200/201 em até 22 s, senão há reenvio. Fonte: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications (guia da Orders API; o comportamento de re-busca + idempotência já é o que o nosso webhook faz).

### Fatos verificados no sandbox (2026-11-21)

Verificados com chamadas diretas à API (credencial `TEST-`, cartão de teste Mastercard aprovado, R$ 10,00), na implementação do back:

- **Status do reembolso na resposta síncrona com cartão**: `POST /v1/payments/{id}/refunds` respondeu **HTTP 201** com o reembolso já `approved` (`amount` = valor total). O fluxo `in_process` continua tratado (pode ocorrer fora do sandbox).
- **Replay com a mesma `X-Idempotency-Key`**: respondeu **HTTP 200** com o mesmo reembolso (mesmo `id`, `approved`), sem criar outro.
- **Segundo estorno total com chave nova** num pagamento já estornado: **HTTP 400**, `cause[0].code = 2063` ("The action requested is not valid for the current payment state"), não `4296`. Cai no 4xx → AC9.
- **Pagamento inexistente**: **HTTP 404**, `cause[0].code = 2000` ("Payment not found").
- **Sem `X-Idempotency-Key`**: **HTTP 400** ("Header X-Idempotency-Key can't be null").
- **Pagamento depois do estorno** (`GET /v1/payments/{id}`): `status = refunded`, `status_detail = refunded`, `transaction_amount_refunded` = valor, e `refunds[]` com o item `{ id, status: "approved", amount }`, no formato que o webhook usa.
- **Saldo no sandbox**: o estorno logo depois da aprovação funcionou sem adicionar saldo ao vendedor de teste.
- No SDK Node, o erro (`MercadoPagoError`) expõe a lista `cause` da resposta como `causes` (plural); o back lê as duas formas.

### Fatos não verificados

- **Notificação no estorno**: não verificado se um reembolso pela Payments API dispara notificação `type=payment` pro `notification_url` do pagamento (exige URL pública; o pagamento do teste acima não tinha `notification_url`). A spec assume que sim (o status do pagamento muda pra `refunded`). Se não disparar, a reconciliação vem pela resposta síncrona e pela ação "reconciliar" do admin (AC22).
- **Prazo de 180 dias** vale pra Payments API legada: documentado só na página da Orders API.
- **Estorno rejeitado depois de `in_process`**: como aparece no `Payment.get` (`refunds[i].status = "rejected"` com pagamento ainda `approved`?). AC18 assume esse formato.

## Decisões desta spec

### Decisões aprovadas (D1–D8)

- **D1 Prazo de cancelamento com estorno**: até 2 horas antes do início da sessão, constante `CANCELLATION_DEADLINE_MINUTES = 120`. Dá tempo de revender o assento. Alternativa descartada: até o início, 24h ou sem prazo. ACs: AC5, AC27.
- **D2 Estorno parcial por assento**: fora de escopo, só estorno total da reserva. Exigiria cancelar parte dos `booking_seats`, vários estornos por pagamento e tratar `partially_refunded`. Alternativa descartada: cancelar assentos avulsos com `amount` parcial.
- **D3 Assentos de reserva cancelada**: apagar `booking_seats` como na expiração + snapshot em `bookings.cancelled_seat_labels`. Mesmo padrão da expiração, sem mexer na constraint central do double-booking. Alternativa descartada: coluna `booking_seats.released_at` com índice único parcial no lugar da constraint. ACs: AC2, AC26, AC32.
- **D4 MP recusa o estorno (4xx ou `rejected`) no cancelamento do cliente**: a reserva continua `confirmed`, o cliente vê o erro e o ingresso continua válido (pode tentar de novo). O cliente nunca fica sem ingresso e sem dinheiro ao mesmo tempo. Alternativa descartada: cancelar mesmo assim e mandar o estorno `failed` pra fila do admin. ACs: AC9, AC10.
- **D5 E-mail de estorno**: dentro do escopo, best-effort síncrono reusando o `NotificationService`, um e-mail quando o estorno é aceito. Alternativa descartada: só o selo em "Meus ingressos". AC31.
- **D6 `charged_back` / `in_mediation`**: só registrar o status e logar `warn`, reserva sem mudança (como hoje). Disputa pode ser revertida a favor do vendedor. Alternativa descartada: invalidar o ingresso. AC19.
- **D7 Estorno feito fora da nossa API (painel do MP) em reserva confirmada**: cancelar a reserva e liberar os assentos, registrando estorno `external`. Dinheiro devolvido não pode deixar ingresso válido. Alternativa descartada: só registrar e logar `warn`. AC17.
- **D8 Estorno `requested` parado**: 2 minutos, igual à tentativa `created` do checkout (timeout de 15 s + retries do SDK nunca passam disso). AC11, AC20.

### Estado da reserva: reusa `cancelled`/`expired`, estado do dinheiro fica em `refunds`

- Escolha: **não** criar status `refunded` em `bookings`. O status da reserva continua dizendo o que aconteceu com o assento (`cancelled` pelo cliente, `expired` pela expiração), e o estado do dinheiro vive na tabela `refunds`.
- Por quê:
  - O gatilho do admin é uma reserva `expired`. Se ela virasse `refunded`, perderia a informação de que expirou (é justamente o que explica por que existe o estorno).
  - Estorno pode ficar `in_process`, falhar e ser re-tentado. Isso é ciclo de vida do dinheiro, não da reserva. Com status na reserva teríamos `refund_pending`, `refund_failed` etc. misturados com o ciclo do assento.
  - `activeBookingCondition`, sweeper, `SessionActivityService` e regras do painel admin já tratam `cancelled`/`expired` como "não trava assento". Nenhuma delas muda.
  - A futura feature de cancelamento de sessão também vai querer "reserva cancelada + estorno", sem status novo.
- `bookings.needs_refund_review` passa a significar "tem dinheiro aprovado que não voltou e precisa de ação humana". Ganha dois escritores novos: estorno rejeitado depois de aceito (AC17) e é limpo quando o estorno conclui (AC13, AC20).

### Tabela `refunds`

Uma linha por **pedido de estorno** de um pagamento (`payments` aprovado). Escolhida em vez de colunas em `payments` porque o estorno tem id próprio no Mercado Pago, ciclo próprio (pedido, em andamento, concluído, falhou), pode ser re-tentado depois de falha (nova linha) e precisa saber quem pediu e por quê.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | gerado pelo back; é também o `X-Idempotency-Key` da chamada ao MP |
| `booking_id` | uuid, FK `bookings.id` | |
| `payment_id` | uuid, FK `payments.id` | a tentativa aprovada que está sendo estornada |
| `external_refund_id` | text, nullable | `id` do reembolso no MP; **índice único parcial** (`WHERE external_refund_id IS NOT NULL`) |
| `status` | text | `requested` (nosso, antes/durante a chamada ao MP), `failed` (nosso, MP recusou a requisição com 4xx, sem reembolso criado), ou o status do reembolso no MP: `in_process`, `approved`, `rejected` |
| `amount_cents` | integer | valor estornado = `payments.amount_cents` da tentativa (estorno total) |
| `reason` | text | `customer_cancellation`, `expired_booking_review`, `external` (estorno feito fora da nossa API, ex: painel do MP); `session_cancelled` reservado pra feature futura |
| `requested_by` | uuid, FK `users.id`, nullable | cliente ou admin que pediu; nulo em `external` |
| `error_code` | text, nullable | código do MP quando `failed` |
| `created_at` | timestamptz | `DEFAULT now()` |
| `updated_at` | timestamptz | `DEFAULT now()` |

- Índice em `booking_id`.
- **Índice único parcial** `refunds_active_per_payment_uq ON refunds (payment_id) WHERE status IN ('requested', 'in_process', 'approved')`: no máximo um estorno ativo ou concluído por pagamento. É a última barreira contra estorno duplo, mesmo com bug na aplicação. `failed` e `rejected` não contam (permitem nova tentativa).
- Como o estorno é sempre total, esse índice também garante que o webhook consegue achar a linha só pelo `payment_id` (o `metadata` do reembolso no MP é o do pagamento, não dá pra mandar o nosso id por lá).
- Migration Drizzle: próxima numeração livre (`0005_*` hoje). Só cria a tabela e índices; nenhum dado existente muda.

### Prazo de cancelamento (D1)

- Constante `CANCELLATION_DEADLINE_MINUTES = 120` (ao lado das constantes de `booking-lock.ts`).
- Cancelamento permitido quando `sessions.starts_at - make_interval(mins => 120) > now()`, sempre com o relógio do banco (mesmo motivo da spec de expiração: clock skew entre instâncias).
- `GET /bookings/mine` devolve `cancellableUntil = starts_at - 120 min` (ISO) pro front mostrar o prazo sem recalcular a regra.

### Cancelamento pelo cliente: `POST /bookings/:id/cancel`

Mesma rota de hoje (`JwtAuthGuard`), sem corpo. A implementação sai de `BookingService.cancelBooking` e passa pro `RefundService` (ver "Módulos").

Ordem de escrita, mesmo padrão tx1 → HTTP → tx2 do `createPayment` (sem transação em volta da chamada HTTP):

1. **tx1**:
   - `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE` (serializa cancelamentos da mesma reserva).
   - Dono diferente ou inexistente → 404.
   - Status `cancelled` do próprio usuário → **replay**: responde 200 com o estado atual (reserva + último estorno), sem chamar o MP. Status `pending`/`expired` → 409 `BOOKING_NOT_CANCELLABLE`.
   - Status `confirmed` com prazo vencido → 409 `CANCELLATION_DEADLINE_PASSED`. (D1)
   - Busca o pagamento aprovado da reserva (`payments.status = 'approved'`). Sem pagamento aprovado (reserva confirmada pelo mock `POST /bookings/:id/confirm` ou pelo seed) → cancela direto nesta transação, sem estorno (ver "Liberação do assento"), e responde `refund: null`.
   - Se já existe estorno `requested` desse pagamento:
     - com `updated_at > now() - 2 min` → 409 `REFUND_IN_PROGRESS` (outra requisição está no meio da chamada ao MP);
     - mais velho → segue pro passo 2 com o **mesmo** `refunds.id` como chave (replay seguro no MP).
   - Se já existe estorno `in_process` → 409 `REFUND_IN_PROGRESS` (só o webhook ou a reconciliação do admin finalizam).
   - Senão insere `refunds` (`status = 'requested'`, `reason = 'customer_cancellation'`, `requested_by = userId`, `amount_cents = payments.amount_cents`) + evento `refund_requested`. Commit.
   - A reserva **continua `confirmed`** e os assentos continuam travados até o MP aceitar o estorno. (D4)
2. **Chamada ao MP**: `paymentRefundClient.total({ payment_id: payments.external_payment_id, requestOptions: { idempotencyKey: refunds.id, timeout: 15_000 } })`, fora de transação.
3. **tx2** (resposta), pela função compartilhada `applyRefundStatus` (ver abaixo):
   - `approved` ou `in_process` → estorno aceito: atualiza `refunds` (`external_refund_id`, `status`) + evento `refund_response`; reserva vira `cancelled` e os `booking_seats` são apagados. Depois do commit: broadcast `released` por assento e e-mail. (D5)
   - `rejected` → `refunds.status = 'rejected'` + `refund_response`; reserva continua `confirmed`; responde 422 `REFUND_REJECTED`. (D4)
   - MP respondeu 4xx (sem reembolso criado) → `refunds.status = 'failed'`, `error_code` + evento `refund_request_failed`; reserva continua `confirmed`; responde 422 `REFUND_REQUEST_INVALID`. (D4)
   - MP respondeu 409 (mesma chave ainda processando) → nada gravado, responde 409 `REFUND_IN_PROGRESS`.
   - Sem resposta (timeout/rede) → nada gravado, a linha fica `requested`, responde 504 `REFUND_PROVIDER_TIMEOUT`. Chamar o cancelamento de novo depois de 2 min re-tenta com a mesma chave.
- Resposta 200:

```json
{
  "bookingId": "uuid",
  "status": "cancelled",
  "refund": { "id": "uuid", "status": "pending", "amountCents": 5000 }
}
```

  `refund.status` exposto pro front é a versão simplificada (ver "Meus ingressos"). `refund` é `null` quando a reserva não tinha pagamento aprovado.
- Erros novos seguem o formato de `payment.exceptions.ts` (`{ statusCode, code, message }`), num `refund.exceptions.ts`:

| HTTP | `code` | Mensagem (pt-BR) |
|---|---|---|
| 409 | `BOOKING_NOT_CANCELLABLE` | Só é possível cancelar ingressos confirmados. |
| 409 | `CANCELLATION_DEADLINE_PASSED` | O cancelamento só é permitido até 2 horas antes do início da sessão. |
| 409 | `REFUND_IN_PROGRESS` | Já existe um estorno em andamento para este ingresso. |
| 409 | `REFUND_NOT_ALLOWED` | Esta reserva não tem estorno pendente de revisão. (só admin) |
| 422 | `REFUND_REQUEST_INVALID` | Não foi possível solicitar o estorno agora. Seu ingresso continua válido. |
| 422 | `REFUND_REJECTED` | O estorno foi recusado pelo provedor de pagamento. Seu ingresso continua válido. |
| 504 | `REFUND_PROVIDER_TIMEOUT` | O provedor de pagamento não respondeu a tempo. Tente novamente. |

### Liberação do assento

- O assento é liberado **na mesma transação** em que a reserva vira `cancelled`: quando o MP aceita o estorno (`approved`/`in_process`), ou na hora pra reserva sem pagamento aprovado.
- `DELETE FROM booking_seats WHERE booking_id = $1 RETURNING seat_id`, igual a expiração faz. Corrige o bug do "Contexto" (assento aparecia livre mas dava 409 ao reservar).
- Depois do commit: `SeatingGateway.broadcastSeatUpdate(sessionId, { seatId, status: "released" })` por assento apagado.
- Os assentos e o valor que o cliente precisa ver em "Meus ingressos" depois do cancelamento passam a vir de um snapshot: coluna nova `bookings.cancelled_seat_labels text[] NULL`, preenchida na mesma transação com os rótulos (`A1`, `A2`) antes do `DELETE`. (D3)
- Hold no Valkey: não existe mais hold desses assentos (apagado na criação da reserva). Nada muda na Valkey.

### Função compartilhada `applyRefundStatus`

`applyRefundStatus(tx, refundRow, mpRefund, source)` em `RefundService`, usada pela resposta síncrona (cliente e admin) e pelo webhook. Sempre começa com `SELECT ... FROM refunds WHERE id = $1 FOR UPDATE` e só transiciona com update condicional, então chamadas concorrentes (tx2 + webhook, admin + webhook) aplicam o efeito uma vez só.

| De → para | Efeito |
|---|---|
| `requested` → `approved`/`in_process` | grava `external_refund_id`; aplica efeito do motivo (abaixo) |
| `in_process` → `approved` | conclui; limpa `needs_refund_review` |
| `requested`/`in_process` → `rejected` | se a reserva já foi cancelada (estorno tinha sido aceito), marca `needs_refund_review = true` e loga `warn`; senão só grava |
| `approved` → qualquer | ignora (estado final) |
| mesmo status | ignora (redelivery) |

Efeito do motivo quando o estorno é aceito:

- `customer_cancellation`: reserva `confirmed` → `cancelled`, snapshot de assentos, apaga `booking_seats`, `released` e e-mail depois do commit.
- `expired_booking_review`: reserva continua `expired` (já não tem assentos). Quando chega em `approved`, `needs_refund_review = false`.
- `external`: ver "Webhook".
- `session_cancelled` (futuro): a feature de cancelamento de sessão define.

### Admin: fila de revisão e estorno

Rotas novas em `AdminRefundsController` (`apps/api/src/admin/refunds/`), `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles("admin")`, como os outros controllers de `/admin/*`.

- `GET /admin/refunds/review`: reservas que precisam de ação, mais recente primeiro:
  - `bookings.needs_refund_review = true` (pagamento aprovado em reserva expirada; estorno rejeitado depois de aceito);
  - ou com estorno `requested` parado há mais de 2 min (timeout sem nova tentativa).

  Cada item: `bookingId`, `bookingStatus`, `customerEmail`, `movieTitle`, `sessionStartsAt`, `amountCents`, `externalPaymentId`, `paymentApprovedAt` (`payments.updated_at`), `reviewReason` (`expired_booking_paid` | `refund_rejected` | `refund_stalled`) e `refund` (último estorno da reserva: `id`, `status`, `errorCode`, `updatedAt`, ou `null`). Sem paginação nesta versão (volume esperado baixo).
- `POST /admin/bookings/:id/refund`: pede o estorno pelo mesmo `RefundService`, com `reason = 'expired_booking_review'` (ou mantém o motivo do estorno parado que está re-tentando) e `requested_by = adminId`.
  - Permitido só quando a reserva aparece na fila: `needs_refund_review = true` ou estorno `requested` parado. Senão → 409 `REFUND_NOT_ALLOWED`.
  - Com estorno `in_process` → **reconcilia** em vez de criar outro: `Payment.get` do pagamento e aplica `applyRefundStatus` com o reembolso encontrado em `refunds[]`. Responde o estado atual.
  - Com estorno `requested` parado → re-tenta com a mesma chave (replay seguro).
  - Mesmo tx1 → MP → tx2 e mesmos códigos de erro do cliente (422/504/409).
  - Resposta 200: `{ bookingId, bookingStatus, refund: { id, status, amountCents } }`.

### Webhook

`handleWebhook` continua igual até `applyPaymentStatus` (re-busca com `Payment.get`, atualiza a tentativa em `payments`, grava `webhook_received`). Muda o tratamento por status:

| `status` do pagamento (via `Payment.get`) | O que fazemos |
|---|---|
| `refunded` | Pra cada item de `payment.refunds[]`: acha a linha em `refunds` por `external_refund_id`; senão pela linha ativa (`requested`/`in_process`) do mesmo `payment_id` (resposta síncrona perdida) e grava o `external_refund_id`; aplica `applyRefundStatus` com o status do item. Evento `refund_confirmed` quando a linha chega em `approved`. Se não existe nenhuma linha (estorno feito no painel do MP): insere `refunds` com `reason = 'external'`, `status = 'approved'`, loga `warn`, e aplica o efeito (D7): reserva `confirmed` → `cancelled` + libera assentos; reserva com `needs_refund_review` → limpa a flag. |
| `approved` com algum `refunds[i].status = 'rejected'` | aplica `applyRefundStatus` → `rejected` (AC17). Sem estorno no `refunds[]`, segue o fluxo de aprovação de hoje. |
| `approved` / `partially_refunded` | só `warn` (estorno parcial feito fora da nossa API, fora de escopo). |
| `charged_back`, `in_mediation` | como hoje: grava o status, reserva sem mudança, log `warn`. (D6) |

- Tudo na mesma transação do webhook (upsert da tentativa + `webhook_received` + efeitos). Broadcast e e-mail depois do commit, pelo mesmo padrão `notify` de `confirmPaidBooking`.
- Redelivery é idempotente: `applyRefundStatus` ignora mesmo status; só `webhook_received` é gravado de novo (é histórico).
- O e-mail de estorno não é enviado pelo webhook (só quando o estorno é aceito na resposta síncrona). Exceção: estorno `external` não envia e-mail.

### `payment_events`

Tipos novos, cada um na mesma transação da mudança de estado:

| Tipo | Quando |
|---|---|
| `refund_requested` | tx1 (linha `requested` criada) |
| `refund_response` | tx2 (resposta `approved`/`in_process`/`rejected` do MP) |
| `refund_request_failed` | tx2 (MP recusou a requisição com 4xx) |
| `refund_confirmed` | estorno chega em `approved` (sync ou webhook) |
| `booking_cancelled` | reserva vira `cancelled` (com ou sem estorno) |

- `payment_id` do evento = a tentativa estornada (nulo em `booking_cancelled` sem pagamento).
- Lista branca do `payload` (`ALLOWED_PAYMENT_EVENT_PAYLOAD_KEYS`) ganha `refund_id`, `mp_refund_id`, `refund_status` e `reason`. Continua proibido qualquer dado pessoal (e-mail do cliente/admin não entra; `requested_by` fica só na tabela `refunds`).
- `source` ganha o valor `admin` além de `sync` e `webhook`.
- Trigger append-only não muda.

### Meus ingressos

`GET /bookings/mine` passa a devolver, além de `confirmed`, reservas `cancelled` e `expired` **que tenham pelo menos uma linha em `refunds`**. Reserva cancelada sem pagamento (mock) não aparece, como hoje.

Campos novos em `MyBooking`:

```json
{
  "amountCents": 5000,
  "cancellableUntil": "2026-11-20T18:00:00.000Z",
  "refund": { "status": "pending", "amountCents": 5000, "requestedAt": "2026-11-20T12:00:00.000Z" }
}
```

- `amountCents`: soma de `booking_seats.price_cents`, ou `refunds.amount_cents` do último estorno quando os assentos já foram apagados. Corrige o "Total" do `TicketsPage`, que hoje calcula `priceCents * seats.length` e erra com meia-entrada.
- `seats`: de `booking_seats` (confirmada) ou de `cancelled_seat_labels` (cancelada). (D3)
- `refund.status` simplificado pro cliente: `requested`/`in_process` → `pending`; `approved` → `completed`; `failed`/`rejected` → `failed`. Último estorno da reserva; `null` se não houver.
- Em reserva `confirmed` com último estorno `failed`/`rejected`, o ingresso continua válido e o front mostra o aviso de falha junto com o botão de cancelar (o cliente pode tentar de novo).

### Front

- `TicketsPage` (`apps/web/src/features/tickets/TicketsPage.tsx`):
  - Diálogo de confirmação passa a dizer o valor e o prazo: "Ao cancelar, o valor de R$ 50,00 será estornado integralmente no cartão usado na compra. O estorno aparece na fatura conforme o prazo do seu banco. Cancelamento permitido até 20/11/2026 18:00 (2 horas antes da sessão)." (D1)
  - Depois de `cancellableUntil`, o botão "Cancelar" some e aparece "Cancelamento encerrado (até 2 horas antes da sessão)".
  - Cancelamento com sucesso não remove mais o ingresso da lista: ele passa a aparecer como cancelado, com o selo do estorno.
  - Selos: `pending` → "Estorno em andamento"; `completed` → "Estorno concluído"; `failed` → "Não foi possível estornar. Nossa equipe vai analisar." (ou, em reserva ainda `confirmed`, "Não foi possível estornar. Seu ingresso continua válido.").
  - Erros: 422/409 mostram o `message` do back; 504 `REFUND_PROVIDER_TIMEOUT` mostra a mensagem e o botão vira "Tentar de novo" (chama o mesmo endpoint; o back re-tenta com a mesma chave).
  - `cancelBooking` (`apps/web/src/features/tickets/api.ts`) passa a ler o corpo de erro e lançar erro tipado com `code` e `message`.
- Admin (`apps/web/src/features/admin/`):
  - Página nova `AdminRefundsPage` em `/admin/refunds`, link "Estornos" no `AdminLayout`/`AdminHomePage`.
  - Tabela da fila (`GET /admin/refunds/review`): filme, sessão, cliente (e-mail), valor, motivo da revisão em pt-BR ("Pagamento aprovado em reserva expirada", "Estorno recusado", "Estorno parado"), status do último estorno.
  - Botão "Estornar" com confirmação ("Estornar R$ 50,00 para cliente@x.com?"). Desabilitado enquanto envia. Com estorno `in_process` o botão vira "Atualizar status" (mesmo endpoint, reconcilia).
  - Depois da resposta, recarrega a fila; erros mostram o `message` do back.

### E-mail (D5)

- `NotificationService.sendRefundRequestedEmail` (nodemailer, mesmo transporte do e-mail de confirmação), síncrono e best-effort: chamado depois do commit da tx2 quando o estorno é aceito (`approved`/`in_process`), pros motivos `customer_cancellation` e `expired_booking_review`. Falha de SMTP só gera `warn`, não desfaz nada.
- Conteúdo: filme, sessão, assentos (do snapshot), valor estornado e "o valor volta na fatura do cartão conforme o prazo do seu banco".
- Não envia e-mail quando o estorno conclui pelo webhook, nem em estorno `external`.
- Se a feature de notificação assíncrona (`docs/flows/notification/spec.md`, em review) entrar antes, este e-mail vira mais um tipo daquela outbox.

### Módulos

- `RefundModule` novo (`apps/api/src/refund/`): `RefundService` (commands: `cancelWithRefund`, `requestAdminRefund`, `applyRefundStatus`, `applyRefundedPayment`), provider `REFUND_CLIENT` (`new PaymentRefund(config)`, ao lado de `PAYMENT_CLIENT` em `mercadopago.providers.ts`), `refund.exceptions.ts`, e o controller do `POST /bookings/:id/cancel` (sai do `BookingConfirmationController`).
- Importa `BookingModule` (snapshot/cancelamento/broadcast) e `NotificationModule`. `PaymentModule` importa `RefundModule` pro webhook chamar `applyRefundedPayment`. `AdminModule` importa `RefundModule`. Nenhum ciclo: `RefundModule` não importa `PaymentModule`. Pra isso, os providers do Mercado Pago (`PAYMENT_CLIENT`, `REFUND_CLIENT`) saem de `PaymentModule` pra um `MercadoPagoModule` compartilhado, importado pelos dois (o `RefundService` usa `Payment.get` na reconciliação do admin).
- `BookingService.cancelBooking` é removido.

## Critérios de aceitação

### Cancelamento pelo cliente (API)

- **AC1**: cancelar reserva `confirmed` própria com pagamento aprovado, dentro do prazo, grava `refunds` com `status = "requested"`, `reason = "customer_cancellation"`, `amount_cents` igual ao do pagamento e evento `refund_requested` em transação já commitada antes de chamar o Mercado Pago; a chamada é um estorno total (sem `amount`) no `external_payment_id` do pagamento com `idempotencyKey = refunds.id`.
- **AC2**: com o estorno `approved` na resposta do Mercado Pago, responde 200 com `status: "cancelled"` e `refund.status: "completed"`; a reserva fica `cancelled`, `booking_seats` dela são apagados (com snapshot dos rótulos), `refunds.status = "approved"` com `external_refund_id`, eventos `refund_response`, `refund_confirmed` e `booking_cancelled`, e sai `seat:update` `released` por assento na room da sessão.
- **AC3**: depois do cancelamento com estorno, outro usuário consegue reservar o mesmo assento (201), e o mapa mostra o assento `free` antes disso.
- **AC4**: com o estorno `in_process` na resposta, a reserva fica `cancelled` e os assentos liberados como na AC2, `refunds.status = "in_process"`, e a resposta traz `refund.status: "pending"`.
- **AC5** (D1): cancelar quando faltam 2 horas ou menos pro início da sessão (relógio do banco) responde 409 `CANCELLATION_DEADLINE_PASSED`, sem chamar o Mercado Pago e sem mudar nada.
- **AC6**: cancelar reserva `confirmed` sem pagamento aprovado (confirmação mock ou seed) cancela e libera os assentos sem chamar o Mercado Pago, responde `refund: null` e grava `booking_cancelled`.
- **AC7**: reserva de outro usuário ou inexistente → 404; reserva `pending` ou `expired` → 409 `BOOKING_NOT_CANCELLABLE`.
- **AC8**: cancelar de novo uma reserva já `cancelled` do próprio usuário responde 200 com o estado atual, sem chamar o Mercado Pago e sem criar outra linha em `refunds`.
- **AC9** (D4): Mercado Pago recusando a requisição com 4xx → 422 `REFUND_REQUEST_INVALID`; `refunds.status = "failed"` com `error_code` e evento `refund_request_failed`; a reserva continua `confirmed` com os assentos; um novo cancelamento cria outra linha em `refunds` e chama o Mercado Pago com chave nova.
- **AC10** (D4): estorno `rejected` na resposta → 422 `REFUND_REJECTED`, `refunds.status = "rejected"`, reserva continua `confirmed` com os assentos.
- **AC11**: sem resposta do Mercado Pago → 504 `REFUND_PROVIDER_TIMEOUT`, a linha continua `requested` e a reserva `confirmed`; um novo cancelamento antes de 2 minutos → 409 `REFUND_IN_PROGRESS` sem chamar o Mercado Pago; depois de 2 minutos chama o Mercado Pago com a **mesma** chave de idempotência e não cria outra linha.
- **AC12**: dois cancelamentos simultâneos da mesma reserva: o Mercado Pago é chamado uma vez só e existe uma única linha em `refunds`; a outra requisição recebe 409 `REFUND_IN_PROGRESS` ou o replay 200 da AC8. Mercado Pago respondendo 409 (mesma chave ainda processando) → 409 `REFUND_IN_PROGRESS`.
- **AC13**: o banco recusa uma segunda linha `requested`/`in_process`/`approved` em `refunds` pro mesmo pagamento (índice único parcial), mesmo inserida fora do serviço.

### Webhook

- **AC14**: webhook de pagamento `refunded` com estorno `in_process` (ou `requested` com resposta síncrona perdida) leva `refunds` pra `approved`, grava `external_refund_id` se faltava, grava `refund_confirmed`, e `payments.status` da tentativa vira `refunded`. Se a reserva ainda estava `confirmed` (resposta síncrona perdida), ela é cancelada e os assentos liberados com `released`.
- **AC15**: o mesmo webhook `refunded` entregue de novo não muda nada além de gravar outro `webhook_received`: nenhum `refund_confirmed` extra, nenhum broadcast, nenhum e-mail.
- **AC16**: webhook `refunded` processado ao mesmo tempo que a tx2 da resposta síncrona (ou que a reconciliação do admin) termina com `refunds` em `approved`, uma única transição e um único `refund_confirmed`.
- **AC17** (D7): webhook `refunded` sem nenhuma linha em `refunds` (estorno feito no painel do Mercado Pago) cria linha `reason = "external"`, `status = "approved"`, loga `warn`; reserva `confirmed` vira `cancelled` com assentos liberados; reserva `expired` com `needs_refund_review` tem a flag limpa.
- **AC18**: webhook mostrando estorno `rejected` pra um estorno que já tinha sido aceito (`in_process`) leva `refunds` pra `rejected`, marca `needs_refund_review = true` na reserva (que continua `cancelled`) e loga `warn`.
- **AC19** (D6): webhook `charged_back` ou `in_mediation` grava o status da tentativa, não muda reserva nem `refunds`, e loga `warn` (comportamento atual mantido).

### Admin (API)

- **AC20**: `GET /admin/refunds/review` lista reservas com `needs_refund_review = true` e reservas com estorno `requested` parado há mais de 2 minutos, com os campos descritos; sem token → 401; token de cliente → 403.
- **AC21**: `POST /admin/bookings/:id/refund` em reserva `expired` com `needs_refund_review` faz estorno total pelo mesmo serviço (`reason = "expired_booking_review"`, `requested_by` = admin, `source = "admin"` nos eventos); a reserva continua `expired`; com estorno `approved`, `needs_refund_review` vira `false` e a reserva sai da fila.
- **AC22**: `POST /admin/bookings/:id/refund` em reserva fora da fila → 409 `REFUND_NOT_ALLOWED`; com estorno `in_process` não cria estorno novo, re-busca o pagamento no Mercado Pago e aplica o status encontrado; com estorno `requested` parado re-tenta com a mesma chave; erros do Mercado Pago seguem os mesmos códigos do cliente (422/504/409).
- **AC23**: dois `POST /admin/bookings/:id/refund` simultâneos pra mesma reserva chamam o Mercado Pago uma vez só.

### Auditoria

- **AC24**: um cancelamento com estorno aprovado gera, na ordem, `refund_requested`, `refund_response`, `refund_confirmed` e `booking_cancelled` em `payment_events`, ligados à tentativa estornada; rollback da tx2 não deixa evento órfão.
- **AC25**: nenhum `payload` de evento de estorno contém e-mail, nome ou CPF de cliente ou admin.

### Meus ingressos (API)

- **AC26** (D3): `GET /bookings/mine` devolve as reservas `confirmed` e as `cancelled`/`expired` que têm estorno, com `amountCents`, `cancellableUntil`, `seats` (do snapshot quando cancelada) e `refund` (`pending`/`completed`/`failed` mapeado do último estorno, ou `null`); reserva cancelada sem pagamento não aparece.

### Front

- **AC27** (D1): em "Meus ingressos", o diálogo de cancelamento mostra o valor total do ingresso, diz que o estorno é integral no cartão da compra e mostra a data/hora limite (`cancellableUntil`); depois do limite o botão "Cancelar" não aparece e aparece o texto de cancelamento encerrado.
- **AC28**: cancelar com sucesso mantém o ingresso na lista como cancelado com o selo do estorno; 409/422 mostram o `message` do back; 504 mostra a mensagem e "Tentar de novo" chama o mesmo endpoint.
- **AC29**: o selo do ingresso mostra "Estorno em andamento", "Estorno concluído" ou a mensagem de falha conforme `refund.status`.
- **AC30**: a página `/admin/refunds` lista a fila com motivo em pt-BR e botão "Estornar" com confirmação; com estorno em andamento o botão vira "Atualizar status"; depois da ação a fila recarrega; erro mostra o `message` do back.

### E-mail

- **AC31** (D5): estorno aceito (`approved`/`in_process`) na resposta síncrona envia um e-mail de estorno solicitado ao dono da reserva (Mailpit em dev), com filme, sessão, assentos e valor; falha de SMTP não muda a resposta nem o estado; webhook e estorno `external` não enviam e-mail.

### Migration

- **AC32**: a migration cria `refunds` (com índice único parcial por pagamento e único parcial em `external_refund_id`) e `bookings.cancelled_seat_labels`; reservas, pagamentos e eventos existentes não mudam.

## Modelo de dados / API (impacto)

- `refunds`: tabela nova.
- `bookings`: coluna nova `cancelled_seat_labels text[] NULL` (D3). `needs_refund_review` ganha escritores novos (rejeição depois de aceito) e passa a ser limpa por código (estorno concluído).
- `booking_seats`: passa a ser apagado também no cancelamento (já era na expiração).
- `payments`: sem mudança de schema; `refunded` agora tem efeito.
- `payment_events`: tipos novos e chaves novas na lista branca; `source = "admin"`.
- `POST /bookings/:id/cancel`: mesmo contrato de entrada; resposta ganha `refund`; novos 409/422/504; reserva já cancelada passa a responder 200 (replay) em vez de 409.
- `GET /bookings/mine`: inclui canceladas/expiradas com estorno; campos `amountCents`, `cancellableUntil`, `refund`.
- `GET /admin/refunds/review` e `POST /admin/bookings/:id/refund`: novos.
- `POST /payments/webhook`: `refunded` passa a ter efeito; `charged_back`/`in_mediation` sem mudança.
- `BookingService.cancelBooking`: removido (vira `RefundService.cancelWithRefund`).
- Valkey: sem mudança.
- `docs/schema.md` e `docs/schema-erd.mmd`: atualizados depois da implementação.

## Testes existentes que mudam

- `apps/api/test/booking.e2e-spec.ts`: `should reject cancelling a booking that isn't confirmed` muda (reserva já cancelada passa a responder 200 replay; o 409 fica pra `pending`/`expired`); `should cancel a confirmed booking and free its seat back up on the seat map` ganha a checagem de que dá pra reservar o assento de novo (é o caso sem pagamento, AC6).
- `apps/api/src/booking/booking.service.spec.ts`: testes de `cancelBooking` saem junto com o método e voltam como testes do `RefundService`.
- `apps/api/test/payment.e2e-spec.ts`: o caso `refunded` da AC26 do checkout passa a esperar o efeito desta spec; `charged_back`/`in_mediation` continuam iguais.
- `apps/api/src/payment/payment.service.spec.ts`: `applyPaymentStatus` com `refunded` passa a chamar `RefundService.applyRefundedPayment`.
- `apps/web/src/features/tickets/TicketsPage.spec.tsx`: o caso que espera o ingresso sumir da lista depois de cancelar muda pra esperar o selo de estorno.
- Helper de limpeza dos testes de integração: inclui `refunds` antes de `payments`/`bookings`.

## Riscos

- **Dinheiro devolvido e ingresso ainda válido** (resposta síncrona perdida depois do MP aceitar): a reserva fica `confirmed` até o webhook (AC14) ou até o cliente/admin chamar de novo (replay com a mesma chave devolve o reembolso já criado). Janela pequena, mesmo modelo do `createPayment`.
- **Webhook de estorno pode não existir** (ver "Fatos não verificados"): sem ele, estorno `in_process` só conclui pela reconciliação manual do admin (AC22). Aceitável no sandbox; confirmar antes de produção.
- **Saldo insuficiente na conta do vendedor**: o MP recusa (4xx) → AC9; o ingresso continua válido e o cliente vê a falha. Em produção isso vira chamado; fora de escopo automatizar.
- **Estorno rejeitado depois de liberar o assento**: o assento pode ter sido revendido. A reserva continua `cancelled` e o caso vai pra fila do admin (`needs_refund_review`, AC18). Não reativamos a reserva.
- **Cancelamento perto do prazo**: a checagem do prazo é na tx1; se a chamada ao MP demorar e passar do limite, o cancelamento conclui mesmo assim (o pedido foi feito dentro do prazo).
- **Chargeback**: só registramos o status; o ingresso continua válido. Cliente que contestou pode usar o ingresso. Aceito nesta versão (D6).

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`. Teste de integração/e2e em português, com `// GIVEN`, `// WHEN`, `// THEN`, sem `it.each`, com setup repetitivo (reserva confirmada paga, sessão perto do início, estorno em dado status, mock do `REFUND_CLIENT`/`PAYMENT_CLIENT`, entrega de webhook) em helpers de `apps/api/test/helpers/` (ex: `refund.ts`). Pra simular o prazo, o helper cria a sessão com `starts_at` relativo a `now()` do banco. Teste de componente (Vitest + RTL) mocka a API. Teste unitário segue `it("should ...")` com 3A, e `it.each` é bem-vindo.

| AC | Nível | Teste |
|----|-------|-------|
| AC1 | integração (Jest + Supertest, Postgres real, MP mockado) | `it("AC1: deve registrar o pedido de estorno antes de chamar o Mercado Pago")` (o mock lê o banco no momento da chamada e confere `idempotencyKey` e ausência de `amount`) |
| AC2 | integração (Postgres + WebSocket reais) | `it("AC2: deve cancelar o ingresso, liberar os assentos e concluir o estorno aprovado")` |
| AC3 | integração | `it("AC3: deve permitir que outra pessoa reserve o assento de um ingresso cancelado")` |
| AC4 | integração | `it("AC4: deve cancelar o ingresso com estorno em processamento")` |
| AC5 | integração | `it("AC5: deve recusar cancelamento a menos de 2 horas da sessão")` |
| AC5 | unitário | condição de prazo (`it.each` com sessão a 3h, 2h01, 2h, 1h, já começada) |
| AC6 | integração | `it("AC6: deve cancelar sem estorno o ingresso confirmado sem pagamento")` |
| AC7 | integração | um `it` por caso: outro usuário (404), reserva `pending` (409), reserva `expired` (409) |
| AC8 | integração | `it("AC8: deve devolver o estado atual ao cancelar de novo um ingresso já cancelado")` |
| AC9 | integração | `it("AC9: deve manter o ingresso válido quando o Mercado Pago recusa o pedido de estorno")` e `it("AC9: deve criar um novo pedido de estorno depois de uma falha")` |
| AC10 | integração | `it("AC10: deve manter o ingresso válido quando o estorno é rejeitado")` |
| AC11 | integração | um `it` por caso: timeout; nova tentativa antes de 2 minutos; nova tentativa depois de 2 minutos com a mesma chave |
| AC12 | integração | `it("AC12: deve chamar o Mercado Pago uma única vez com dois cancelamentos simultâneos")` (`Promise.all`) e `it("AC12: deve responder estorno em andamento quando o Mercado Pago ainda processa a mesma chave")` |
| AC13 | integração | `it("AC13: deve impedir no banco dois estornos ativos para o mesmo pagamento")` |
| AC14 | integração | um `it` por caso: estorno `in_process` concluído pelo webhook; resposta síncrona perdida (reserva ainda `confirmed`) |
| AC15 | integração | `it("AC15: deve ignorar webhook de estorno repetido")` |
| AC16 | integração | `it("AC16: deve concluir o estorno uma única vez com webhook e resposta síncrona simultâneos")` |
| AC17 | integração | um `it` por caso: reserva `confirmed`; reserva `expired` em revisão |
| AC18 | integração | `it("AC18: deve mandar para revisão o estorno rejeitado depois de aceito")` |
| AC19 | integração | um `it` por status: `charged_back` e `in_mediation` |
| AC20 | integração | `it("AC20: deve listar na fila as reservas que precisam de estorno")` + um `it` por acesso negado (401, 403) |
| AC21 | integração | `it("AC21: deve estornar pelo admin o pagamento aprovado em reserva expirada")` |
| AC22 | integração | um `it` por caso: fora da fila (409); reconciliação de `in_process`; re-tentativa de `requested` parado |
| AC23 | integração | `it("AC23: deve chamar o Mercado Pago uma única vez com dois estornos simultâneos do admin")` |
| AC24 | integração | `it("AC24: deve registrar o histórico completo de um cancelamento com estorno")` e `it("AC24: não deve deixar evento quando a transação falha")` |
| AC25 | unitário | builder do `payload` descarta chaves fora da lista branca (inclui `refund_id`, `mp_refund_id`, `refund_status`, `reason`) |
| AC26 | integração | `it("AC26: deve listar em Meus ingressos o ingresso cancelado com o status do estorno")` |
| AC26 | unitário | mapeamento do status do estorno pro cliente (`it.each`) |
| AC27 | componente (Vitest + RTL) | diálogo mostra valor e prazo; depois do prazo não há botão "Cancelar" |
| AC28 | componente | sucesso mantém o ingresso com selo; 422 mostra `message`; 504 mostra "Tentar de novo" e reenvia |
| AC29 | componente | um caso por status de estorno (`it.each`) |
| AC30 | componente | fila renderiza motivos; "Estornar" pede confirmação e chama a API; "Atualizar status" com estorno em andamento |
| AC31 | integração (Mailpit) | `it("AC31: deve enviar e-mail de estorno solicitado")` e `it("AC31: não deve falhar o cancelamento quando o e-mail falha")` |
| AC32 | integração | `it("AC32: deve criar a tabela de estornos sem alterar dados existentes")` |
| — | unitário | `applyRefundStatus` por transição (`it.each`), mapeamento de erro do MP pra exceção, montagem da chamada `total` (chave e timeout) |
| — | e2e (Playwright) | fluxo feliz: comprar ingresso no sandbox mockado, cancelar em "Meus ingressos", ver o selo e o assento livre em outra aba |
