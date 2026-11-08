# Spec: Checkout transparente com cartão (Core Methods)

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...) e não têm relação com nenhuma outra numeração externa.

## Contexto

Hoje o pagamento usa Checkout Pro:

- `CheckoutPage` (`apps/web/src/features/checkout/CheckoutPage.tsx`) chama `bookSeats` **a cada clique em "Pagar"**, depois `createCheckout` (`POST /bookings/:id/checkout`) e redireciona o navegador pro `init_point` do Mercado Pago.
- `PaymentService.createCheckout` (`apps/api/src/payment/payment.service.ts`) cria uma Preference (`PREFERENCE_CLIENT`, `apps/api/src/payment/mercadopago.providers.ts`) com `back_urls` apontando pra `/checkout/retorno` (`CheckoutReturnPage`, rota pública em `apps/web/src/App.tsx`).
- `PaymentService.handleWebhook` extrai o id do pagamento (`extractPaymentId`: formato Webhooks `type=payment` + `data.id`, formato IPN `topic=payment` + `resource` no corpo, ou `?topic=payment&id=...` na query), re-busca o pagamento com `Payment.get`, faz upsert em `payments` por `booking_id` (único, com guarda `status <> 'approved'`) e então:
  - `approved` → `BookingService.confirmPaidBooking` (vira `confirmed`, broadcast `booked`, e-mail);
  - `rejected`/`cancelled` → `BookingService.releaseFailedPaymentBooking` (vira `cancelled` e apaga `booking_seats`).
- `payments` (`apps/api/src/db/schema.ts`) tem `booking_id` único: uma linha por reserva.

Esta spec troca o Checkout Pro pelo Checkout Transparente com **Core Methods**: o formulário de pagamento é 100% nosso (layout, validações, mensagens), e só número do cartão, validade e código de segurança são campos seguros do Mercado Pago (iframes do MercadoPago.js v2). O front gera o token do cartão e manda pro back, que cria o pagamento direto na Payments API (`Payment.create`) e recebe o `status` na resposta.

### Dependência

Esta spec depende de `docs/flows/pending-booking-expiry/spec.md` (expiração de reserva pendente, ainda em revisão). De lá vêm: `bookings.expires_at` (10 min), status `expired`, a regra de "pagamento em andamento" (`payments.status IN ('pending', 'in_process')` trava a reserva mesmo vencida), o 409 `BOOKING_EXPIRED` e o tratamento de pagamento aprovado pra reserva já expirada (AC14 daquela spec). Quem libera o assento de uma reserva abandonada ou com cartão recusado é a expiração, não esta spec.

## Escopo

- Pagamento com cartão de crédito no Checkout Transparente via Core Methods (MercadoPago.js v2, `mp.fields`).
- Formulário nosso: detecção de bandeira pelo BIN, emissor, parcelas, nome do titular, tipo e número de documento (CPF), e-mail, validações e mensagens em pt-BR, criação do token do cartão.
- Novo endpoint de resumo da reserva pro front saber o valor (`GET /bookings/:id/payment-summary`).
- Novo endpoint de pagamento (`POST /bookings/:id/payments`) com tentativa idempotente gerada pelo cliente.
- Várias tentativas de pagamento por reserva (cartão recusado pode tentar de novo enquanto a reserva não expira).
- Histórico append-only em `payment_events`.
- Remoção do Checkout Pro (Preference, `/checkout/retorno`).

## Fora de escopo

- Pix e boleto.
- Cartão de débito (Core Methods suporta, mas aqui `getInstallments` usa `paymentTypeId: "credit_card"`; débito fica pra outra spec).
- 3DS (não enviamos `three_d_secure_mode`).
- Reembolso, estorno e tratamento automático de chargeback.
- Cartão salvo (customers/cards).
- Polling ou tela que acompanha um pagamento `in_process` até o fim (a confirmação chega por webhook e aparece em "Meus ingressos").

## Fatos do Mercado Pago usados (verificados na documentação)

- Core Methods Web: o SDK carrega de `https://sdk.mercadopago.com/js/v2` ou pelo pacote npm `@mercadopago/sdk-js` (`loadMercadoPago()` e depois `new window.MercadoPago(PUBLIC_KEY)`). Campos seguros com `mp.fields.create('cardNumber' | 'expirationDate' | 'securityCode', ...).mount(...)`. Evento `binChange` no campo do número; `mp.getPaymentMethods({ bin })`; `mp.getIssuers({ paymentMethodId, bin })` só quando `additional_info_needed` inclui `issuer_id`; `mp.getInstallments({ amount, bin, paymentTypeId: 'credit_card' })` com opções em `payer_costs`; `mp.getIdentificationTypes()`; `mp.fields.createCardToken({ cardholderName, identificationType, identificationNumber })`. O token é de uso único (válido por 7 dias). Fonte: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/card/integrate-via-core-methods
- PCI: a página de tipos de integração diz que Bricks, Cardform, Core Methods Web e Core Methods Mobile são elegíveis a **SAQ A**, porque número, CVV e validade trafegam por iframe direto pros servidores do Mercado Pago. A página de PCI lista "Checkout Transparente → SAQ A" e "Web Tokenize Checkout → A-EP". Fontes: https://www.mercadopago.com/developers/pt/docs/checkout-api-payments/types-of-integration e https://www.mercadopago.com/developers/pt/docs/security/pci
- `Payment.create` (`POST /v1/payments`): corpo com `token`, `transaction_amount`, `installments`, `payment_method_id`, `issuer_id`, `payer.email`, `payer.identification { type, number }`, `description`. O header `X-Idempotency-Key` é obrigatório; no SDK Node é `requestOptions: { idempotencyKey }`. Fonte: https://www.mercadopago.com/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/other-payment-methods (exemplo Node com `requestOptions.idempotencyKey`).
- Idempotência: reenviar com a mesma chave devolve o pagamento já criado em vez de criar outro; se o processamento original ainda não terminou, a API responde 409 ("The process has not been completed yet. Try again later."). Fonte: https://www.mercadopago.com/developers/pt/docs/wallet-connect-legacy/payment-flow/idempotency/introduction e `.../idempotency/responses` (documentação da Wallet Connect; a página da Payments API não detalha as respostas, ver "Perguntas em aberto").
- SDK Node `mercadopago@3.6.1` (instalado): sem `idempotencyKey` explícito o SDK gera um UUID por chamada; timeout padrão 60s; até 3 retries em 429/5xx reaproveitando a mesma chave (`node_modules/mercadopago/dist/utils/restClient/index.js`, `dist/utils/config/index.js`).
- `notification_url` pode ser definido por pagamento; o Mercado Pago pode notificar por Webhooks e por IPN (com `?source_news=ipn`, só IPN). Fonte: https://www.mercadopago.com/developers/pt/docs/checkout-pro-orders/resources/notifications/ipn
- Status e `status_detail` de pagamento: https://www.mercadopago.com/developers/pt/docs/checkout-api-payments/response-handling/query-results (`cancelled`/`expired` = pendente por 30 dias; `pending`/`pending_challenge` = 3DS).

## Decisões desta spec

### Front: formulário próprio com Core Methods

- Fluxo da página em duas etapas:
  1. **Resumo** (como hoje: assentos, inteira/meia, documento da meia). Botão "Continuar para pagamento" chama `bookSeats` **uma vez** e guarda o `bookingId` no estado da página. Depois disso inteira/meia ficam travadas (o preço já foi gravado em `booking_seats.price_cents`).
  2. **Pagamento**: lê `GET /bookings/:id/payment-summary` e mostra o nosso formulário de cartão com o total vindo do back.
- SDK: pacote `@mercadopago/sdk-js` com versão exata (hoje `0.0.3`, publicado em 2023-06-23; `pnpm add @mercadopago/sdk-js --filter web` e conferir que ficou sem `^`). O pacote só injeta o script oficial de `https://sdk.mercadopago.com/js/v2` (o script tem que vir do domínio do Mercado Pago, não pode ser empacotado). Não tem script de `install`/`postinstall`, então não entra em `onlyBuiltDependencies`. Vantagem sobre `<script>` no `index.html`: carrega só na página de checkout e dá um módulo pra mockar nos testes (`vi.mock("@mercadopago/sdk-js")`).
- Instância: `new window.MercadoPago(import.meta.env.VITE_MP_PUBLIC_KEY, { locale: "pt-BR" })`, isolada num módulo `apps/web/src/features/checkout/mercadopago.ts` (único lugar que fala com o SDK).
- Campos seguros (iframes do Mercado Pago): `cardNumber`, `expirationDate`, `securityCode`, montados com `mp.fields.create(...).mount(...)`. Nenhum `<input>` nosso recebe número, validade ou CVV.
- Campos nossos: nome do titular, tipo de documento (opções de `mp.getIdentificationTypes()`, padrão CPF), número do documento, e-mail, emissor (só quando exigido), parcelas.
- Bandeira e emissor: no `binChange`, com BIN novo → `mp.getPaymentMethods({ bin })` → guarda `payment_method_id` (`results[0].id`) e mostra a bandeira. Se `additional_info_needed` incluir `issuer_id`, mostra o select com `mp.getIssuers({ paymentMethodId, bin })`; senão usa `results[0].issuer.id`. BIN apagado limpa bandeira, emissor e parcelas.
- Parcelas: `mp.getInstallments({ amount: String(amountCents / 100), bin, paymentTypeId: "credit_card" })`, opções de `payer_costs` (rótulo `recommended_message`, valor `installments`).
- Validações antes de gerar token (mensagens em pt-BR, exibidas no campo): nome obrigatório; CPF com 11 dígitos e dígitos verificadores válidos; e-mail com formato válido; parcelas escolhidas; campos seguros válidos (eventos `validityChange`/`error` do `mp.fields`, mensagem nossa pra cada um). Botão "Pagar" desabilitado enquanto inválido ou enviando.
- Envio: a cada submit, o front gera um `attemptId` novo (`crypto.randomUUID()`), cria um token novo com `mp.fields.createCardToken({ cardholderName, identificationType, identificationNumber })` (token é de uso único) e chama `POST /bookings/:id/payments`.
- Reenvio da mesma tentativa: se a chamada falhar sem resposta (rede caiu) ou com 504 `PAYMENT_PROVIDER_TIMEOUT`, o botão vira "Tentar de novo" e reenvia **o mesmo `attemptId` com o mesmo token**. Isso é replay idempotente, não cobrança nova.
- Nova tentativa: depois de resposta `rejected` ou 422, o formulário continua na tela com o mesmo `bookingId`; o próximo "Pagar" gera `attemptId` e token novos. `bookSeats` nunca é chamado de novo.
- Voltar à página com reserva pendente: se `bookSeats` responder 409 `code: "BOOKING_ALREADY_PENDING"` com `bookingId` (ver "Reserva pendente do próprio usuário"), o front retoma essa reserva e vai direto pra etapa de pagamento.
- Resultado: `approved` → mensagem de sucesso e link pra "Meus ingressos". `in_process`/`pending` → "Pagamento em análise. Você recebe a confirmação por e-mail e o ingresso aparece em Meus ingressos." `rejected` → mensagem do back (`message`). 409 `BOOKING_EXPIRED` → mensagem e botão da spec de expiração (AC16 de lá).
- Config: `VITE_MP_PUBLIC_KEY` em `apps/web/.env.example`, `apps/web/src/vite-env.d.ts`, e como build arg em `apps/web/Dockerfile` e `docker-compose.yml` (mesmo padrão de `VITE_API_URL`, inlined no build). Access token continua só no back (`MERCADOPAGO_ACCESS_TOKEN`).
- PCI: pela documentação do Mercado Pago, Core Methods Web é elegível a SAQ A. Número, validade e CVV nunca passam pelo nosso front nem pelo nosso back (só o token). Nome, CPF e e-mail passam pelo back pra montar o `payer`, mas não são persistidos.

### Reserva pendente do próprio usuário

- `POST /sessions/:id/book` e `POST /sessions/:id/seats/:seatId/book`: quando o conflito vem de **uma** reserva `pending` que ainda trava o assento (regra da spec de expiração), do **mesmo usuário**, com **exatamente o mesmo conjunto de assentos**, a resposta continua 409, mas com `{ "statusCode": 409, "code": "BOOKING_ALREADY_PENDING", "bookingId": "<id>", "message": "Você já tem uma reserva pendente para esses assentos." }`.
- Qualquer outro conflito segue o 409 de hoje, sem `bookingId` (não vaza reserva de outra pessoa).
- Por que no back e não em `sessionStorage`: funciona em reload, nova aba e outro dispositivo, sem estado no navegador.

### Endpoint de resumo

`GET /bookings/:id/payment-summary` (`JwtAuthGuard`):

```json
{
  "bookingId": "uuid",
  "status": "pending",
  "expiresAt": "2026-11-08T12:10:00.000Z",
  "amountCents": 5000,
  "currency": "BRL",
  "description": "Filme X - A1, A2",
  "seats": [{ "seatId": "uuid", "label": "A1", "ticketType": "full", "priceCents": 3000 }]
}
```

- `amountCents = SUM(booking_seats.price_cents)` da reserva. É a mesma função usada pra calcular `transaction_amount` no pagamento (uma fonte só).
- Reserva de outro usuário ou inexistente → 404. Reserva expirada (`expired`, ou `pending` com `expires_at <= now()`) → 409 `BOOKING_EXPIRED`. Outro status (`confirmed`, `cancelled`) → 409 `code: "BOOKING_NOT_PENDING"`.

### Endpoint de pagamento

`POST /bookings/:id/payments` (`JwtAuthGuard`). Corpo (DTO com `class-validator`):

```json
{
  "attemptId": "uuid v4",
  "token": "card token",
  "paymentMethodId": "visa",
  "issuerId": "25",
  "installments": 1,
  "payer": { "email": "x@y.com", "identification": { "type": "CPF", "number": "12345678909" } }
}
```

- O DTO não declara `amount`/`transactionAmount`. O `ValidationPipe` global (`whitelist: true`, `apps/api/src/main.ts`) descarta o campo se o front mandar; o valor cobrado sempre vem do back.
- Resposta 200 (tentativa nova ou replay): `{ attemptId, paymentId, status, statusDetail, message, bookingStatus }`, com `message` em pt-BR derivada de `status_detail`.
- Erros: 404 (reserva de outro usuário ou inexistente); 409 `BOOKING_EXPIRED`; 409 `BOOKING_NOT_PENDING`; 409 `PAYMENT_IN_PROGRESS` (já existe tentativa em andamento); 409 `ATTEMPT_ID_CONFLICT` (`attemptId` já usado em outra reserva); 422 `PAYMENT_REQUEST_INVALID` quando o Mercado Pago recusa a requisição com 4xx (token inválido ou expirado, dados inválidos), sem pagamento criado; 504 `PAYMENT_PROVIDER_TIMEOUT` quando não houve resposta do Mercado Pago (tentativa fica `created`, front reenvia o mesmo `attemptId`).

### Contrato do `Payment.create`

Montado por uma função pura (`buildPaymentRequest`) a partir da reserva carregada do banco e do DTO:

```ts
paymentClient.create({
  body: {
    token: dto.token,
    transaction_amount: amountCents / 100, // SUM(booking_seats.price_cents), never from the client
    installments: dto.installments,
    payment_method_id: dto.paymentMethodId,
    issuer_id: dto.issuerId ? Number(dto.issuerId) : undefined,
    payer: {
      email: dto.payer.email,
      identification: { type: dto.payer.identification.type, number: dto.payer.identification.number },
    },
    external_reference: booking.id,
    notification_url: `${PUBLIC_API_URL}/payments/webhook`,
    description: `${movie.title} - ${seatLabels}`,
    metadata: { attempt_id: attemptId },
  },
  requestOptions: { idempotencyKey: attemptId, timeout: 15_000 },
});
```

- `PREFERENCE_CLIENT` sai; `PAYMENT_CLIENT` continua (`Payment.get` no webhook e `Payment.create` aqui).
- Os retries internos do SDK reaproveitam a mesma chave, então são seguros.

### Modelo de tentativas: `payments` vira uma linha por tentativa

Escolha: alterar `payments` pra uma linha por tentativa, em vez de criar `payment_attempts` ao lado.

- Por quê: a regra de "pagamento em andamento" da spec de expiração é `EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('pending', 'in_process'))`. Com uma linha por tentativa esse SQL continua certo sem mudança (qualquer tentativa em andamento trava). Com uma tabela nova, aquela spec teria que trocar a tabela consultada, e `payments` ficaria com dois significados (resumo por reserva e tentativas). A consulta de revisão de estorno daquela spec (`bookings.status = 'expired' AND payments.status = 'approved'`) também continua valendo.
- Colunas depois da migration:

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | = `attemptId` do cliente nas tentativas novas; linhas antigas mantêm o id atual |
| `booking_id` | uuid, FK `bookings.id` | **deixa de ser único**; índice não único |
| `provider` | text | sem mudança (`mercado_pago`) |
| `external_payment_id` | text, nullable | id do pagamento no Mercado Pago; **índice único parcial** (`WHERE external_payment_id IS NOT NULL`) |
| `status` | text | `created` (nosso, antes de chamar o MP), `request_failed` (nosso, MP recusou a requisição com 4xx, sem pagamento), `abandoned` (nosso, ver "Tentativa `created` parada") ou o `status` do MP |
| `status_detail` | text, nullable | novo |
| `amount_cents` | integer | sem mudança |
| `installments` | integer, nullable | novo |
| `payment_method_id` | text, nullable | novo |
| `created_at` | timestamptz | sem mudança |
| `updated_at` | timestamptz | novo, `DEFAULT now()` |

- Migration (Drizzle, próxima numeração livre depois da migration da spec de expiração):
  1. `ALTER TABLE payments DROP CONSTRAINT payments_booking_id_unique;`
  2. `ALTER TABLE payments ADD COLUMN status_detail text, ADD COLUMN installments integer, ADD COLUMN payment_method_id text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();`
  3. `CREATE INDEX payments_booking_id_idx ON payments (booking_id);`
  4. `CREATE UNIQUE INDEX payments_external_payment_id_uq ON payments (external_payment_id) WHERE external_payment_id IS NOT NULL;` Se já existir duplicado (não deveria, era uma linha por reserva), a migration falha e o deploy para; não deduplicar automaticamente.
- Linhas existentes (Checkout Pro) ficam como estão: já têm `external_payment_id` e o último `status` recebido. Cada uma vira "uma tentativa".
- Mapeamento do webhook (que só traz o id do pagamento) pra tentativa, depois de `Payment.get`:
  1. `payments.external_payment_id = payment.id` (caminho normal: gravado na tx2);
  2. senão, `payments.id = payment.metadata.attempt_id` com `booking_id = payment.external_reference` (tx2 não chegou a gravar: processo caiu ou tx2 falhou) → grava o `external_payment_id` agora;
  3. senão, se tem `external_reference` (pagamento de Preference antiga, ainda em trânsito), insere linha nova com `id` aleatório;
  4. sem `external_reference` → ignora (como hoje).
- Guarda de regressão por linha: nunca voltar uma linha `approved` pra `pending`/`in_process`/`authorized`/`rejected`/`cancelled` (entrega atrasada). `approved` → `refunded`/`charged_back`/`in_mediation` é permitido (o `Payment.get` traz o status atual).

### Ordem de escrita (sem transação em volta da chamada HTTP)

1. **tx1** (commit antes de chamar o MP):
   - `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE` (serializa tentativas da mesma reserva).
   - Valida dono (404), status `pending` e `expires_at > now()` (409 `BOOKING_EXPIRED` ou `BOOKING_NOT_PENDING`).
   - Se já existe `payments.id = attemptId`: com outra reserva → 409 `ATTEMPT_ID_CONFLICT`; com status diferente de `created` → responde o resultado guardado sem chamar o MP (replay); com status `created` → segue pro passo 2 com a mesma chave (replay no MP).
   - Se existe outra tentativa da reserva com status `pending`/`in_process`, ou `created` recente (ver "Tentativa `created` parada") → 409 `PAYMENT_IN_PROGRESS`.
   - Insere `payments` (`id = attemptId`, `status = 'created'`, `amount_cents`) + evento `attempt_created`. Commit.
2. **Chamada ao MP** (`Payment.create`, chave = `attemptId`), fora de qualquer transação.
3. **tx2** (commit da resposta): atualiza a linha (`external_payment_id`, `status`, `status_detail`, `installments`, `payment_method_id`) + evento `mp_response`, e aplica o efeito na reserva pela mesma função compartilhada do webhook (`applyPaymentStatus`, ver tabela). Se `approved`, `confirmPaidBooking` roda dentro da tx2 (passa a receber `tx`) e grava `booking_confirmed`; broadcast `booked` e e-mail saem depois do commit.
   - MP respondeu 4xx (sem pagamento criado): tx2 grava `status = 'request_failed'` + evento `mp_request_failed` (só o código de erro do MP), responde 422.
   - Sem resposta (timeout ou rede): nada é gravado; a linha fica `created`; responde 504. O front reenvia o mesmo `attemptId`.
- Se a tx2 falhar ou o processo morrer depois do MP responder, o webhook reconcilia pela ordem de mapeamento acima (`external_payment_id` → `metadata.attempt_id` → `external_reference`).
- Valkey não participa de nada disso (não existe transação Valkey + Postgres; o hold já foi apagado na criação da reserva).

### Tentativa `created` parada (pra revisar)

- Uma linha `created` só fica parada se o MP não respondeu e o cliente não reenviou. Com `timeout: 15_000` e os retries do SDK, nenhuma chamada passa de ~2 min.
- Proposta: `created` com `created_at > now() - interval '2 minutes'` bloqueia nova tentativa (409 `PAYMENT_IN_PROGRESS`). Mais velha que isso: antes da tx1, o back busca no MP (`Payment.search` por `external_reference = booking.id`) um pagamento com `metadata.attempt_id` igual; se achar, aplica o status (como no webhook); se não achar, marca a linha `abandoned` (evento `attempt_abandoned`) e libera a nova tentativa.
- Pra revisar: o limite de 2 min e se a busca no MP vale a complexidade (alternativa: só esperar o webhook e deixar a reserva expirar).

### Status do Mercado Pago e o que fazemos

Função única `applyPaymentStatus(tx, bookingId, paymentRow)`, usada pela resposta síncrona e pelo webhook:

| `status` do MP | Linha em `payments` | Reserva | Resposta ao front |
|---|---|---|---|
| `approved` | grava | `confirmPaidBooking` (`confirmed`, broadcast `booked`, e-mail). Se a reserva estiver `expired`, segue a AC14 da spec de expiração (não reativa, log `warn` pra revisão de estorno) | sucesso |
| `rejected` | grava | **continua `pending`** (pode tentar de novo até `expires_at`) | mensagem de `status_detail` |
| `in_process` | grava | continua `pending`; trava a reserva mesmo vencida (regra da spec de expiração); bloqueia nova tentativa | "em análise" |
| `pending` | grava | igual a `in_process` | "em análise" |
| `authorized` | grava | continua `pending`, log `warn` (não esperado: não usamos `capture: false`) | "em análise" |
| `cancelled` | grava | **continua `pending`**; a expiração libera | mensagem genérica de recusa |
| `refunded` | grava | sem mudança, log `warn` (estorno fora de escopo) | — (só webhook) |
| `charged_back` | grava | sem mudança, log `warn` | — (só webhook) |
| `in_mediation` | grava | sem mudança, log `warn` | — (só webhook) |
| outro ou desconhecido | grava | sem mudança, log `warn` | mensagem genérica |

- `releaseFailedPaymentBooking` deixa de ter chamador e é removido (com seus testes). A liberação de assento de reserva recusada ou abandonada passa a ser só a da spec de expiração.
- Um `rejected` atrasado de uma tentativa antiga nunca afeta a reserva: rejeição não muda reserva, e a confirmação só acontece de `pending` pra `confirmed`.

### Mensagens de `status_detail` (pt-BR)

Função pura `paymentStatusMessage(status, statusDetail)` no back, com fallback. Mapeamento inicial:

| `status_detail` | Mensagem |
|---|---|
| `accredited` | Pagamento aprovado! |
| `pending_contingency`, `pending_review_manual`, `offline_process`, `deferred_retry` | Pagamento em análise. Você recebe a confirmação por e-mail. |
| `cc_rejected_bad_filled_card_number` | Confira o número do cartão. |
| `cc_rejected_bad_filled_date` | Confira a data de validade. |
| `cc_rejected_bad_filled_security_code` | Confira o código de segurança. |
| `cc_rejected_bad_filled_other` | Confira os dados do cartão. |
| `cc_rejected_insufficient_amount` | Saldo ou limite insuficiente. Use outro cartão. |
| `cc_rejected_invalid_installments` | Esse cartão não aceita esse número de parcelas. |
| `cc_rejected_call_for_authorize` | Autorize o pagamento com o banco emissor e tente de novo. |
| `cc_rejected_card_disabled` | Cartão desabilitado. Ligue para o banco emissor ou use outro cartão. |
| `cc_rejected_duplicated_payment` | Você já fez um pagamento com esse valor. Use outro cartão se precisar pagar de novo. |
| `cc_rejected_max_attempts` | Limite de tentativas atingido. Use outro cartão. |
| `cc_rejected_high_risk`, `rejected_high_risk` | Pagamento recusado. Use outro cartão. |
| fallback (`rejected`/`cancelled` com outro detalhe) | Pagamento recusado. Confira os dados ou use outro cartão. |
| fallback (status desconhecido) | Não foi possível concluir o pagamento. Tente de novo. |

### Histórico `payment_events` (append-only)

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `booking_id` | uuid, FK `bookings.id` | |
| `payment_id` | uuid, FK `payments.id`, nullable | a tentativa; nulo só em evento sem tentativa mapeável |
| `type` | text | `attempt_created`, `mp_response`, `mp_request_failed`, `webhook_received`, `booking_confirmed`, `attempt_abandoned` |
| `payload` | jsonb | só chaves da lista branca abaixo |
| `created_at` | timestamptz | `DEFAULT now()` |

- Índice em `(booking_id, created_at)`.
- Cada evento é gravado na **mesma transação Postgres** da mudança de estado correspondente: `attempt_created` na tx1; `mp_response`/`mp_request_failed` e `booking_confirmed` na tx2; `webhook_received` (e `booking_confirmed`, se for o caso) na transação do webhook. A chamada HTTP ao MP não tem evento próprio: não dá pra ser atômica com o banco, e `attempt_created` já marca a intenção.
- Lista branca do `payload` (montado por função tipada que só copia essas chaves): `attempt_id`, `mp_payment_id`, `status`, `status_detail`, `amount_cents`, `installments`, `payment_method_id`, `source` (`sync`/`webhook`), `error_code`. **Nunca** token, CPF, e-mail, nome do titular, BIN nem qualquer dado de cartão.
- Não é event sourcing: estado atual continua em `payments` e `bookings`; `payment_events` é auditoria. Dentro da regra "CQRS light, sem event store" do `CLAUDE.md`.
- Append-only garantido no banco (pra revisar): trigger `BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW` que dá `RAISE EXCEPTION`. Trigger em vez de `REVOKE UPDATE, DELETE`, porque a API conecta com o dono das tabelas (o mesmo usuário roda as migrations) e o dono pode se re-conceder privilégios. Efeito colateral: a limpeza dos testes de integração (que hoje usa `delete`) precisa de um helper que apague `payment_events` com `TRUNCATE` (trigger de linha não pega `TRUNCATE`) ou com o trigger desligado (`SET session_replication_role = replica` na conexão de teste).

### Webhook

- Continua re-buscando o pagamento (`Payment.get`), nunca confia no corpo da notificação.
- `extractPaymentId` não muda: os três formatos (Webhooks `type`/`data.id`, IPN `topic`/`resource` no corpo, IPN só na query) continuam aceitos. Preferences criadas antes do deploy ainda podem gerar pagamento e notificação IPN; o caminho 3 do mapeamento (linha nova por `external_reference`) cobre isso.
- Tudo numa transação: upsert da linha + `webhook_received` + `applyPaymentStatus`. Redelivery é idempotente (mesmo status → nenhuma mudança na reserva; `webhook_received` é gravado de novo, é histórico).

### Remoção do Checkout Pro

- Back: rota `POST /bookings/:id/checkout`, `PaymentService.createCheckout`, `CheckoutResult`, `PREFERENCE_CLIENT` e o provider de `Preference`. `WEB_URL` deixa de ser usado pelo pagamento.
- Front: `createCheckout` em `apps/web/src/features/checkout/api.ts`, `CheckoutReturnPage.tsx` + `CheckoutReturnPage.spec.tsx`, a rota `/checkout/retorno` e o comentário dela em `App.tsx`, e o caso `"should show the Mercado Pago return page without requiring a logged-in session"` em `App.spec.tsx`.
- A spec `public-catalog-login-gate` já prevê essa troca: `POST /bookings/:id/payments` e `GET /bookings/:id/payment-summary` ficam com `JwtAuthGuard`.

## Critérios de aceitação

- **AC1**: `GET /bookings/:id/payment-summary` devolve, pra reserva `pending` dentro do prazo do próprio usuário, `amountCents` igual à soma de `booking_seats.price_cents`, a lista de assentos e `expiresAt`; reserva de outro usuário → 404; reserva expirada → 409 `BOOKING_EXPIRED`; reserva `confirmed`/`cancelled` → 409 `BOOKING_NOT_PENDING`.
- **AC2**: na etapa de pagamento, número, validade e código de segurança são montados com `mp.fields.create` (`cardNumber`, `expirationDate`, `securityCode`) e a página não tem nenhum `<input>` nosso pra esses dados.
- **AC3**: digitar um BIN detecta a bandeira (`getPaymentMethods`), mostra o select de emissor só quando `additional_info_needed` inclui `issuer_id`, e carrega as parcelas com `getInstallments` usando o valor do resumo; apagar o BIN limpa bandeira, emissor e parcelas.
- **AC4**: os tipos de documento vêm de `getIdentificationTypes`; nome vazio, CPF inválido, e-mail inválido, parcelas não escolhidas ou campo seguro inválido mostram mensagem em pt-BR no campo e não geram token.
- **AC5**: ao pagar, o front gera token com `createCardToken` (nome, tipo e número do documento) e envia só `attemptId`, `token`, `paymentMethodId`, `issuerId`, `installments` e `payer`; nenhum dado de cartão vai pra nossa API.
- **AC6**: "Continuar para pagamento" chama `bookSeats` uma vez; depois de um pagamento recusado, nova tentativa usa o mesmo `bookingId`, gera `attemptId` e token novos e não chama `bookSeats` de novo; sem resposta da API, "Tentar de novo" reenvia o mesmo `attemptId` e token.
- **AC7**: voltar ao checkout (reload ou nova aba) com reserva pendente do próprio usuário pros mesmos assentos não cria reserva nova: a criação responde 409 `BOOKING_ALREADY_PENDING` com o `bookingId` e o front retoma essa reserva na etapa de pagamento.
- **AC8**: conflito com reserva de outro usuário, ou do mesmo usuário com conjunto de assentos diferente, continua 409 sem `bookingId`.
- **AC9**: `POST /bookings/:id/payments` com cartão aprovado responde `status: "approved"` e a reserva já está `confirmed` na resposta, com broadcast `booked` e e-mail, pelo mesmo caminho (`applyPaymentStatus` + `confirmPaidBooking`) usado pelo webhook.
- **AC10**: o valor enviado ao Mercado Pago é a soma de `booking_seats.price_cents` da reserva; um `amount` no corpo da requisição é ignorado.
- **AC11**: a chamada `Payment.create` leva `token`, `transaction_amount`, `installments`, `payment_method_id`, `issuer_id`, `payer.email`, `payer.identification`, `external_reference = booking.id`, `notification_url`, `description`, `metadata.attempt_id` e `idempotencyKey = attemptId`.
- **AC12**: a tentativa é gravada com `status = "created"` e evento `attempt_created` em transação já commitada antes da chamada ao Mercado Pago.
- **AC13**: reenviar o mesmo `attemptId` depois de uma resposta final devolve o mesmo resultado sem chamar o Mercado Pago de novo.
- **AC14**: reenviar o mesmo `attemptId` com a tentativa ainda `created` (resposta perdida) chama o Mercado Pago com a mesma chave de idempotência e não gera um segundo pagamento.
- **AC15**: duas requisições simultâneas com `attemptId` diferentes pra mesma reserva: só uma chega ao Mercado Pago; a outra recebe 409 `PAYMENT_IN_PROGRESS`.
- **AC16**: nova tentativa enquanto outra da mesma reserva está `in_process` ou `pending` → 409 `PAYMENT_IN_PROGRESS`.
- **AC17**: `attemptId` já usado em outra reserva → 409 `ATTEMPT_ID_CONFLICT`.
- **AC18**: cartão recusado responde `status: "rejected"` com a mensagem pt-BR do `status_detail` (ou o fallback), mantém a reserva `pending` e aceita uma nova tentativa com outro `attemptId`.
- **AC19**: `in_process`/`pending` responde "em análise", mantém a reserva `pending` e a confirmação final vem pelo webhook.
- **AC20**: Mercado Pago recusando a requisição com 4xx → 422 `PAYMENT_REQUEST_INVALID`, tentativa `request_failed`, reserva `pending`; sem resposta do Mercado Pago → 504 `PAYMENT_PROVIDER_TIMEOUT` e tentativa continua `created`.
- **AC21**: pagamento em reserva expirada (`expired` ou `pending` vencida) → 409 `BOOKING_EXPIRED`, sem chamar o Mercado Pago; reserva de outro usuário → 404; reserva `confirmed`/`cancelled` → 409 `BOOKING_NOT_PENDING`.
- **AC22**: webhook `rejected` ou `cancelled` grava o status da tentativa e mantém a reserva `pending` (não chama mais `releaseFailedPaymentBooking`).
- **AC23**: webhook `rejected` atrasado de uma tentativa antiga não muda reserva confirmada por outra tentativa, e nenhuma linha `approved` volta pra status anterior.
- **AC24**: webhook de pagamento cuja tx2 não foi gravada (linha sem `external_payment_id`) encontra a tentativa por `metadata.attempt_id`, grava o id do pagamento e aplica o status.
- **AC25**: webhook `approved` repetido confirma a reserva uma única vez (um e-mail, um broadcast).
- **AC26**: webhook `refunded`, `charged_back` ou `in_mediation` grava o status, não muda a reserva e registra log `warn`.
- **AC27**: webhook `approved` pra reserva `expired` segue a AC14 de `docs/flows/pending-booking-expiry/spec.md`.
- **AC28**: webhook nos formatos IPN legados (`topic`/`resource` no corpo e `?topic=payment&id=` na query) de pagamento de Preference antiga continua sendo processado, criando uma linha nova por `external_reference`.
- **AC29**: um pagamento aprovado gera, na ordem, `attempt_created`, `mp_response` e `booking_confirmed` em `payment_events`; webhook depois disso gera `webhook_received`; rollback da transação não deixa evento órfão.
- **AC30**: nenhum `payload` em `payment_events` contém token, CPF, e-mail ou nome do titular, mesmo quando esses dados estão no corpo da requisição.
- **AC31**: `UPDATE` ou `DELETE` em `payment_events` falha no banco.
- **AC32**: `POST /bookings/:id/checkout` não existe mais (404) e a rota `/checkout/retorno` foi removida do front.

## Modelo de dados / API (impacto)

- `payments`: deixa de ter `booking_id` único; ganha `status_detail`, `installments`, `payment_method_id`, `updated_at`; índice único parcial em `external_payment_id`. Uma linha por tentativa.
- `payment_events`: tabela nova + trigger append-only.
- `GET /bookings/:id/payment-summary`: novo.
- `POST /bookings/:id/payments`: novo.
- `POST /bookings/:id/checkout`: removido.
- `POST /sessions/:id/book` e `POST /sessions/:id/seats/:seatId/book`: 409 `BOOKING_ALREADY_PENDING` com `bookingId` no caso do próprio usuário com o mesmo conjunto de assentos.
- `POST /payments/webhook`: mapeamento por tentativa; `rejected`/`cancelled` não liberam mais a reserva.
- `BookingService.releaseFailedPaymentBooking`: removido. `confirmPaidBooking`: passa a rodar dentro da transação de quem chama (broadcast e e-mail depois do commit).
- Front: nova dependência `@mercadopago/sdk-js` (versão exata) e variável `VITE_MP_PUBLIC_KEY` (também como build arg).
- Valkey: sem mudança.

## Testes existentes que mudam

- `apps/api/src/payment/payment.service.spec.ts`:
  - removidos com `createCheckout`: `should create a preference with one item per seat and return its init_point`, `should point the webhook notification at the public API url`, `should omit auto_return when WEB_URL is a plain http dev url, since Mercado Pago rejects it`, `should include auto_return when WEB_URL is https`, `should throw NotFound when the booking belongs to another user`, `should throw Conflict when the booking is no longer pending` (os dois últimos voltam como testes do serviço de pagamento novo);
  - mudam de comportamento: `should release the booking's seats when the payment is rejected` e `should release the booking's seats when the payment is cancelled (expired)` (passam a esperar a reserva mantida `pending`); `should guard the payments upsert so a later notification can't overwrite an approved row` (alvo do conflito vira `external_payment_id`, guarda por linha); `should confirm the booking when the re-fetched payment is approved` (via `applyPaymentStatus` em transação);
  - `should neither confirm nor release the booking while the payment is still pending/in_process` continua, sem a parte de "release";
  - o mock `releaseFailedPaymentBooking` sai do `mockBookingService`;
  - testes de formato IPN (`topic`/`resource`, só query, sem corpo, `merchant_order`) e `should skip payments without an external reference` continuam.
- `apps/api/src/booking/booking.service.spec.ts`: `should cancel a pending booking and delete its seat rows when the payment fails` e `should do nothing when releaseFailedPaymentBooking is redelivered for a booking that's already past pending` são removidos.
- `apps/api/test/payment.e2e-spec.ts`: bloco `POST /bookings/:id/checkout` removido; `should cancel the booking and free the seat for rebooking when the payment is rejected` e `should not let a late notification for an older payment attempt overwrite an already-approved payment row` substituídos pelos testes das AC22 e AC23.
- `apps/web/src/features/checkout/CheckoutPage.spec.tsx`: `should book the seat and redirect to the Mercado Pago checkout page` e `should show an error and never create a checkout when the atomic booking request fails` reescritos pro fluxo novo.
- `apps/web/src/features/checkout/CheckoutReturnPage.spec.tsx`: removido. `apps/web/src/App.spec.tsx`: caso da página de retorno removido.

## Riscos

- **Resposta perdida do Mercado Pago**: coberto por `attemptId` persistido antes da chamada, replay com a mesma chave e reconciliação pelo webhook (`metadata.attempt_id`).
- **Corrida entre expiração e chamada ao MP**: a tentativa `created` não conta como "pagamento em andamento" na regra da spec de expiração. Se a reserva vencer durante os segundos da chamada e o pagamento for aprovado, cai na AC14 daquela spec (revisão manual de estorno). Janela pequena: a tx1 só aceita reserva com `expires_at > now()`.
- **Script malicioso na nossa página**: com campos seguros o número do cartão não passa pelo nosso DOM, mas o resto do formulário (nome, CPF, e-mail) passa. Mitigação proposta: CSP com `script-src` restrito ao nosso domínio e `https://sdk.mercadopago.com` (pra revisar; hoje não existe CSP).
- **Pacote `@mercadopago/sdk-js` pouco mantido** (`0.0.3`, de 2023): é só um loader do script oficial. Se der problema, troca por `<script>` injetado manualmente sem mudar o resto.

## Decisões pra revisar

- `cancelled` também mantém a reserva `pending` (a expiração libera), igual a `rejected`.
- `payments` vira uma linha por tentativa em vez de tabela nova `payment_attempts` (motivo: a regra da spec de expiração continua valendo sem mudança).
- 409 `BOOKING_ALREADY_PENDING` com `bookingId` em vez de devolver 200 com a reserva existente (inteira/meia poderiam divergir do que o usuário escolheu agora).
- Tentativa `created` parada: limite de 2 min e busca no MP antes de liberar nova tentativa.
- Append-only por trigger, e como os testes limpam `payment_events`.
- Mensagens pt-BR de `status_detail` ficam no back (o front só exibe `message`).
- `timeout: 15_000` na chamada `Payment.create` (padrão do SDK é 60s).
- CSP na página de checkout.

## Perguntas em aberto

- A documentação da Payments API (`/v1/payments`) não detalha a resposta pra mesma `X-Idempotency-Key` com corpo diferente nem com processamento em andamento; os detalhes citados vêm da documentação da Wallet Connect. Confirmar no sandbox antes de implementar a AC14.
- Esta spec muda duas premissas da spec de expiração, que precisa ser ajustada por quem entrar depois na `main`: (1) a AC13 de lá (`rejected`/`cancelled` liberam a reserva) deixa de valer, e `releaseFailedPaymentBooking` é removido em vez de ganhar broadcast; (2) a nota "`payments.booking_id` é único" deixa de valer (o SQL de "pagamento em andamento" continua correto).

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`. Teste de integração/e2e em português, com `// GIVEN`, `// WHEN`, `// THEN`, sem `it.each`, com setup repetitivo (reserva pendente, reserva vencida, tentativa em dado status, mock do `PAYMENT_CLIENT`) em helpers de `apps/api/test/helpers/`. Teste de componente (Vitest + RTL) mocka `@mercadopago/sdk-js` e a API. Teste unitário segue `it("should ...")` com 3A, e `it.each` é bem-vindo.

| AC | Nível | Teste |
|----|-------|-------|
| AC1 | integração (Jest + Supertest, Postgres real) | um `it` por caso: `AC1: deve devolver o total da reserva pendente somando os preços dos assentos`, `AC1: deve responder 404 para reserva de outro usuário`, `AC1: deve responder 409 BOOKING_EXPIRED para reserva vencida`, `AC1: deve responder 409 BOOKING_NOT_PENDING para reserva confirmada` |
| AC2 | componente | etapa de pagamento chama `fields.create` com `cardNumber`, `expirationDate` e `securityCode` e não renderiza input de cartão |
| AC3 | componente | BIN → bandeira e parcelas com o valor do resumo; emissor só com `issuer_id` em `additional_info_needed`; BIN vazio limpa |
| AC4 | componente | um caso por validação (nome, CPF, e-mail, parcelas, campo seguro inválido): mensagem pt-BR e `createCardToken` não chamado |
| AC4 | unitário | validador de CPF (`it.each` com válidos, dígito errado, tamanho errado, todos iguais) |
| AC5 | componente | corpo do `POST /bookings/:id/payments` tem só os campos permitidos |
| AC6 | componente | recusa e nova tentativa: `bookSeats` uma vez, `createCardToken` duas vezes, dois POSTs com `attemptId` diferentes e mesmo `bookingId` |
| AC6 | componente | sem resposta → "Tentar de novo" reenvia o mesmo `attemptId` e token |
| AC7 | integração | `it("AC7: deve devolver a reserva pendente do próprio usuário em vez de criar outra")` |
| AC7 | componente | 409 `BOOKING_ALREADY_PENDING` leva direto pra etapa de pagamento com o `bookingId` recebido |
| AC8 | integração | um `it` por caso: reserva de outro usuário; reserva do mesmo usuário com outros assentos |
| AC9 | integração | `it("AC9: deve confirmar a reserva na própria resposta quando o cartão é aprovado")` |
| AC10 | integração | `it("AC10: deve cobrar o total calculado no servidor mesmo com valor adulterado no corpo")` |
| AC11 | unitário | `buildPaymentRequest` monta o corpo e o `idempotencyKey` esperados |
| AC12 | integração | `it("AC12: deve gravar a tentativa antes de chamar o Mercado Pago")` (o mock do MP lê o banco no momento da chamada) |
| AC13 | integração | `it("AC13: deve devolver o resultado guardado ao reenviar a mesma tentativa")` |
| AC14 | integração | `it("AC14: deve repetir a chamada com a mesma chave quando a tentativa ficou sem resposta")` |
| AC15 | integração | `it("AC15: deve deixar só uma de duas tentativas simultâneas chegar ao Mercado Pago")` (`Promise.all`) |
| AC16 | integração | um `it` por status: tentativa `in_process` e tentativa `pending` bloqueiam nova tentativa |
| AC17 | integração | `it("AC17: deve recusar identificador de tentativa já usado em outra reserva")` |
| AC18 | integração | `it("AC18: deve manter a reserva pendente e permitir nova tentativa após cartão recusado")` |
| AC18 | unitário | `paymentStatusMessage` (`it.each` com cada `status_detail` mapeado e os dois fallbacks) |
| AC19 | integração | `it("AC19: deve manter a reserva pendente com pagamento em análise")` |
| AC20 | integração | um `it` por caso: 4xx do Mercado Pago; timeout do Mercado Pago |
| AC21 | integração | um `it` por caso: reserva `expired`, `pending` vencida, de outro usuário, `confirmed` |
| AC22 | integração | um `it` por status: `rejected` e `cancelled` pelo webhook mantêm a reserva pendente |
| AC23 | integração | `it("AC23: deve ignorar recusa atrasada de tentativa antiga em reserva já confirmada")` |
| AC24 | integração | `it("AC24: deve reconciliar pelo webhook a tentativa sem id de pagamento gravado")` |
| AC25 | integração | `it("AC25: deve confirmar uma única vez com webhook aprovado repetido")` |
| AC26 | integração | um `it` por status: `refunded`, `charged_back`, `in_mediation` |
| AC27 | integração | `it("AC27: deve registrar o pagamento aprovado sem reativar a reserva expirada")` |
| AC28 | integração | um `it` por formato: IPN no corpo e IPN só na query |
| AC29 | integração | `it("AC29: deve registrar o histórico completo de uma tentativa aprovada")` e `it("AC29: não deve deixar evento quando a transação falha")` |
| AC30 | unitário | builder do `payload` descarta token, CPF, e-mail e nome |
| AC30 | integração | `it("AC30: não deve gravar dados pessoais nem de cartão no histórico")` |
| AC31 | integração | um `it` por operação: `UPDATE` e `DELETE` em `payment_events` falham |
| AC32 | integração + componente | `POST /bookings/:id/checkout` responde 404; `/checkout/retorno` não renderiza a página de retorno |
| — | unitário | `applyPaymentStatus` por status (`it.each`) e guarda de regressão de status por linha |
