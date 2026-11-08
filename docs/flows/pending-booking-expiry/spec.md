# Spec: Expiração de reserva pendente

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...) e não têm relação com nenhuma outra numeração externa.

## Contexto

Quando o cliente cria uma reserva (`POST /sessions/:id/book` ou `POST /sessions/:id/seats/:seatId/book`, `apps/api/src/booking/booking.service.ts`), a API grava um `bookings` com `status = "pending"` e uma linha em `booking_seats` por assento, e apaga o hold da Valkey (`releaseHoldsForBookedSeats`). A partir daí quem trava o assento é a constraint única `booking_seats (session_id, seat_id)` no Postgres.

Uma reserva só sai de `pending` por três caminhos:

- webhook do Mercado Pago com pagamento `approved` → `confirmPaidBooking` (vira `confirmed`);
- webhook com pagamento `rejected`/`cancelled` → `releaseFailedPaymentBooking` (vira `cancelled` e apaga os `booking_seats`). Esse caminho vale enquanto o Checkout Pro estiver em uso: a spec de checkout transparente remove `releaseFailedPaymentBooking` e mantém a reserva `pending` (ver "Relação com outras specs");
- `POST /bookings/:id/confirm` (confirmação mock).

Se o cliente abandona o checkout e nenhum webhook chega, a reserva fica `pending` pra sempre e o assento nunca mais pode ser reservado naquela sessão. Pior: o mapa de assentos hoje só conta reservas `confirmed` como ocupadas (`getBookedSeatIds` e `isSeatBooked` em `apps/api/src/seating/seating.service.ts`), então o assento travado aparece como `free`, outro cliente consegue segurá-lo (hold na Valkey) e só descobre o problema com um 409 na hora de reservar.

Esta spec dá prazo de validade à reserva pendente: 10 minutos. Depois disso, sem pagamento em andamento, o assento volta a ficar livre.

## Escopo

- Coluna `bookings.expires_at` e migration com backfill.
- Regra única de "reserva que ainda trava o assento", aplicada no mapa, no hold e na criação de reserva (verificação preguiçosa, sem depender de job).
- Na criação de reserva, reservas pendentes vencidas que conflitam com os assentos pedidos são expiradas na mesma transação.
- Sweeper periódico que expira reservas vencidas e avisa os clientes por WebSocket (só limpeza e UX, a correção não depende dele).
- Proteção da reserva com pagamento em andamento no Mercado Pago.
- Webhook de pagamento aprovado chegando pra reserva já expirada (marcação `needs_refund_review`).
- Validade da preferência do Checkout Pro alinhada ao prazo da reserva.
- Alerta único pra pagamento em andamento há mais de 24h.
- Checkout e confirm de reserva expirada respondem 409, e o front mostra mensagem e manda o cliente de volta pra escolha de assentos.

## Fora de escopo

- Estorno automático de pagamento aprovado depois da expiração (fica revisão manual).
- E-mail ou notificação avisando o cliente que a reserva expirou.
- TTL configurável por cinema, sessão ou forma de pagamento (é uma constante global).
- Contador regressivo de tempo no checkout.
- Painel ou fila de revisão pra pagamentos aprovados de reserva expirada (a marcação fica no banco, `bookings.needs_refund_review`, e a consulta é manual).
- Aviso ao cliente de que o pagamento caiu numa reserva expirada.
- Expirar automaticamente reserva com pagamento em andamento, mesmo depois de 24h (só alerta, ver "Pagamento em andamento há mais de 24h").

## Decisões desta spec

### Prazo da reserva pendente

- Constante `PENDING_BOOKING_TTL_MINUTES = 10` no módulo de booking.
- Nova coluna `bookings.expires_at` (`timestamptz`, `NOT NULL`).
- Na criação da reserva, `expires_at` é calculado pelo relógio do banco: `now() + make_interval(mins => PENDING_BOOKING_TTL_MINUTES)`, no mesmo `INSERT`. Nunca usar `new Date()` da instância da API (ver Riscos, clock skew).
- A coluna ganha `DEFAULT now() + interval '10 minutes'` no banco, pra que inserts que não passam o campo (ex: `seed.ts`, que cria reserva `confirmed` direto) continuem funcionando. O serviço de booking sempre passa o valor explicitamente a partir da constante.
- `expires_at` só tem significado pra `status = "pending"`. Em reserva `confirmed`/`cancelled`/`expired` o valor é ignorado.

### Migration e backfill

- Nova migration Drizzle (`apps/api/drizzle/0003_*.sql`), gerada a partir do `schema.ts`, com ajuste manual pro backfill:
  1. `ALTER TABLE bookings ADD COLUMN expires_at timestamptz;`
  2. `UPDATE bookings SET expires_at = created_at + interval '10 minutes';` (todas as linhas, não só as pendentes, pra poder aplicar `NOT NULL`).
  3. `ALTER TABLE bookings ALTER COLUMN expires_at SET DEFAULT (now() + interval '10 minutes'), ALTER COLUMN expires_at SET NOT NULL;`
  4. `ALTER TABLE bookings ADD COLUMN needs_refund_review boolean NOT NULL DEFAULT false;` (ver "Pagamento aprovado pra reserva já expirada"). Linhas existentes ficam `false`.
  5. `ALTER TABLE bookings ADD COLUMN stale_payment_alerted_at timestamptz;` (nullable, sem default; ver "Pagamento em andamento há mais de 24h"). Linhas existentes ficam `NULL`.
- Efeito esperado no deploy: reservas pendentes antigas (criadas há mais de 10 min, que hoje travam assento pra sempre) passam a ser tratadas como vencidas imediatamente. A primeira rodada do sweeper limpa todas elas, respeitando a regra de pagamento em andamento.

### Novo status `expired`

- A reserva vencida vai pra `status = "expired"`, não `cancelled`.
- `bookings.status` é `text` livre, sem enum nem `CHECK` no banco (`apps/api/src/db/schema.ts`), então adicionar o valor não exige mudança de constraint.
- Por que um status próprio: `cancelled` hoje já tem dois significados (cancelamento pelo cliente via `POST /bookings/:id/cancel` e pagamento recusado via webhook). Expiração é um terceiro motivo, e é justamente o caso que pode receber um pagamento aprovado atrasado e precisar de revisão manual de estorno. Com `expired` dá pra achar esses casos por consulta simples (`status = 'expired'` + `payments.status = 'approved'`), sem tabela extra de motivo.
- Telas e consultas que listam só `confirmed` (ex: `GET /bookings/mine`) não mudam: reserva expirada continua fora da lista.

### Pagamento em andamento

- Uma reserva tem **pagamento em andamento** quando existe linha em `payments` com `booking_id` dela e `status IN ('pending', 'in_process')`.
  - A regra é escrita com `EXISTS` sobre qualquer linha de `payments` da reserva, então vale tanto pro modelo de hoje (uma linha por reserva, sobrescrita a cada webhook) quanto pro modelo da spec de checkout transparente (uma linha por tentativa, `booking_id` sem unicidade). Basta **uma** tentativa `pending`/`in_process` pra travar; tentativas `rejected`, `cancelled`, `approved` ou com status internos (`created`, `request_failed`, `abandoned`) não contam.
  - Motivo: o cliente pode já ter pago e a confirmação do Mercado Pago ainda não chegou. Expirar nesse momento liberaria o assento pra outra pessoa com o pagamento já em curso.
- **Nunca** expirar reserva `pending` com pagamento em andamento, nem pelo caminho preguiçoso nem pelo sweeper. O assento continua travado mesmo depois de `expires_at`.
- Quando esse pagamento termina:
  - `approved` → `confirmPaidBooking` confirma normalmente (`confirmed`, broadcast `booked`, e-mail). A reserva ainda está `pending`, então o fluxo atual já funciona.
  - `rejected`/`cancelled` com Checkout Pro → `releaseFailedPaymentBooking` libera normalmente (`cancelled`, apaga `booking_seats`). Ganha um broadcast `released` por assento (ver "Mapa e broadcast").
  - `rejected`/`cancelled` com checkout transparente → a reserva continua `pending` (cliente pode tentar de novo). Sem outra tentativa em andamento, ela passa a ser expirável assim que `expires_at` vence, e quem libera o assento é esta spec (verificação preguiçosa ou sweeper).
- Limitação conhecida: a linha em `payments` só existe depois do primeiro webhook. Com o Checkout Pro (redirecionamento), o cliente pode estar na página do Mercado Pago sem nenhuma linha em `payments` ainda, e a reserva expira normalmente aos 10 min. Mitigação na decisão "Validade da preferência no Mercado Pago" abaixo.

### Regra única: reserva que trava o assento

Uma reserva **trava** seus assentos quando:

```sql
b.status = 'confirmed'
OR (
  b.status = 'pending'
  AND (
    b.expires_at > now()
    OR EXISTS (
      SELECT 1 FROM payments p
      WHERE p.booking_id = b.id AND p.status IN ('pending', 'in_process')
    )
  )
)
```

Uma reserva `pending` é **expirável** quando `b.status = 'pending' AND b.expires_at <= now()` e não tem pagamento em andamento.

A regra fica num único lugar (helper SQL/Drizzle no módulo de booking, ex: `activeBookingCondition()` / `expirableBookingCondition()`) e é usada pelo mapa, pelo hold, pela criação de reserva e pelo sweeper. Sempre com `now()` do banco.

### Verificação preguiçosa (correção sem job)

1. **Mapa de assentos** (`GET /sessions/:id/seats`): `getBookedSeatIds` passa a usar a regra "trava o assento" em vez de `status = 'confirmed'`. Reserva pendente dentro do prazo (ou com pagamento em andamento) aparece como `booked`. Reserva pendente vencida e sem pagamento em andamento aparece como `free`, mesmo que o sweeper ainda não tenha passado.
2. **Hold** (`POST /sessions/:id/seats/:seatId/hold`): `isSeatBooked` usa a mesma regra. Segurar assento travado por reserva pendente dentro do prazo responde 409. Segurar assento de reserva vencida (sem pagamento em andamento) é permitido.
3. **Criação de reserva**: dentro da mesma transação, antes de inserir os `booking_seats`:

   ```sql
   UPDATE bookings b SET status = 'expired'
   WHERE b.status = 'pending'
     AND b.expires_at <= now()
     AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('pending', 'in_process'))
     AND b.id IN (
       SELECT bs.booking_id FROM booking_seats bs
       WHERE bs.session_id = $sessionId AND bs.seat_id = ANY($seatIds)
     )
   RETURNING b.id, b.session_id;
   ```

   Em seguida `DELETE FROM booking_seats WHERE booking_id = ANY(<ids retornados>)` (todos os assentos dessas reservas, não só os pedidos agora, porque a reserva expirada inteira deixa de valer). Depois disso o insert segue como hoje, e a constraint única continua sendo a garantia final.
   - Concorrência: o `UPDATE ... WHERE status = 'pending'` trava a linha da reserva. Se duas criações disputam o mesmo assento vencido, a segunda espera, reavalia o `WHERE` (já não é `pending`) e segue pro insert, onde a constraint única garante que só uma ganha. A perdedora recebe o 409 de hoje.
   - Depois do commit, os assentos das reservas expiradas que **não** foram reservados agora recebem broadcast `released` (os que foram reservados agora recebem `booked`, ver abaixo).
   - Reserva pendente dentro do prazo, ou vencida com pagamento em andamento, continua bloqueando: 409 como hoje.

### Sweeper

- Novo provider (ex: `PendingBookingSweeper` em `apps/api/src/booking/`) com `@Interval(60_000)` do `@nestjs/schedule`.
- `@nestjs/schedule` **não está instalado** hoje (`apps/api/package.json`). Entra como dependência nova com versão exata (`pnpm add @nestjs/schedule --filter api`, conferir que ficou sem `^`), compatível com Nest 11, e `ScheduleModule.forRoot()` no `AppModule`. Não tem script de postinstall, então não precisa de `onlyBuiltDependencies`.
- Cada execução:
  1. Se uma execução anterior ainda estiver rodando nessa instância (flag `running` em memória), pula esse tick e loga em `debug`.
  2. Numa transação, expira em lote com update condicional:

     ```sql
     UPDATE bookings b SET status = 'expired'
     WHERE b.id IN (
       SELECT b2.id FROM bookings b2
       WHERE b2.status = 'pending' AND b2.expires_at <= now()
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b2.id AND p.status IN ('pending', 'in_process'))
       ORDER BY b2.expires_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED
     )
     AND b.status = 'pending'
     RETURNING b.id, b.session_id;
     ```

  3. Na mesma transação, lê os `seat_id` dos `booking_seats` dessas reservas e apaga essas linhas.
  4. Depois do commit, emite `seat:update` com `status: "released"` por assento via `SeatingGateway.broadcastSeatUpdate`, e loga `info` com `bookingId` e assentos liberados (útil se um pagamento aprovado chegar depois, já que os `booking_seats` são apagados).
  5. Marca e alerta pagamentos em andamento há mais de 24h (ver "Pagamento em andamento há mais de 24h").
- Lote de 100 por tick (pra não segurar transação longa); se o lote veio cheio, roda o próximo lote no mesmo tick até esvaziar.
- Seguro com várias instâncias da API: `FOR UPDATE SKIP LOCKED` + `AND b.status = 'pending'` no `UPDATE` garantem que cada reserva é expirada por uma única instância, e só essa instância emite o broadcast dela.
- Idempotente: rodar de novo sem reservas vencidas não muda nada nem emite broadcast.
- Erro numa execução é logado em `error` e não derruba a API. A flag `running` é limpa num `finally`.
- O sweeper é só limpeza e UX (libera linhas e avisa clientes com o mapa aberto). A correção nunca depende dele: com o sweeper desligado, mapa, hold e criação de reserva continuam corretos pela verificação preguiçosa.

### Mapa e broadcast

- `SeatEventStatus` (`"held" | "released" | "booked"`, `seating.gateway.ts`) não muda.
- Criação de reserva pendente passa a emitir `booked` por assento depois do commit. Hoje ela só apaga o hold sem broadcast, e como o mapa vai mostrar pendente dentro do prazo como `booked`, quem está com o mapa aberto precisa ver o mesmo estado sem refazer a consulta.
- Expiração (preguiçosa ou sweeper) emite `released` por assento liberado.
- `releaseFailedPaymentBooking` passa a emitir `released` por assento liberado (hoje não emite, porque o mapa nem mostrava o pendente como ocupado). Vale só enquanto o Checkout Pro estiver em uso; com o checkout transparente esse método é removido e o `released` vem da expiração.

### Checkout e confirm de reserva expirada

- `POST /bookings/:id/checkout` (`PaymentService.createCheckout`) e `POST /bookings/:id/confirm` (`BookingService.confirmBooking`) respondem **409** quando a reserva:
  - está com `status = "expired"`; ou
  - está `pending` com `expires_at <= now()` (sweeper ainda não passou). Vale mesmo com pagamento em andamento: não se abre nova tentativa nem se confirma pelo mock depois do prazo; o pagamento em andamento termina pelo webhook.
- Corpo do 409 com código estável pro front distinguir de outros 409: `{ "statusCode": 409, "code": "BOOKING_EXPIRED", "message": "Reserva expirada. Escolha os assentos novamente." }`.
- Se o endpoint de checkout for substituído por `POST /bookings/:id/payments` antes desta implementação, a regra vale pra ele no lugar.

### Validade da preferência no Mercado Pago

- Ao criar a preferência do Checkout Pro (`PaymentService.createCheckout`), o corpo passa `expires: true` e `expiration_date_to = booking.expires_at` (ISO 8601 com fuso, lido do banco, sem recalcular na API). Assim o Mercado Pago recusa iniciar pagamento depois que a reserva venceu, o que fecha a maior parte da janela da "Limitação conhecida" (cliente pagando no Checkout Pro sem linha em `payments` ainda).
- Vale enquanto o Checkout Pro existir. Não se aplica ao checkout transparente, que não usa preferência: lá o próprio `POST /bookings/:id/payments` recusa reserva vencida com 409 `BOOKING_EXPIRED`.
- Verificação pendente na implementação (não muda a decisão): testar no sandbox do Mercado Pago se `expiration_date_to` também bloqueia pagamento já iniciado antes do prazo e concluído depois (ex: Pix gerado e pago depois). Se não bloquear, esse caso cai no AC14 (revisão manual de estorno).

### Pagamento aprovado pra reserva já expirada

Caso: cliente pagou, mas a reserva já foi expirada (sem pagamento em andamento no momento da expiração) e o assento pode até já ter outro dono.

- Não reatribuir assento. A reserva continua `expired`, sem `booking_seats`.
- O `payments` é gravado normalmente com `status = "approved"` (o upsert atual já faz isso; no modelo de uma linha por tentativa, é a linha da tentativa).
- Nova coluna `bookings.needs_refund_review boolean NOT NULL DEFAULT false`.
- `confirmPaidBooking` hoje ignora em silêncio qualquer reserva fora de `pending`. Passa a distinguir: se a reserva está `expired`, roda `UPDATE bookings SET needs_refund_review = true WHERE id = $1 AND status = 'expired' AND needs_refund_review = false RETURNING id` e, se a linha voltou, loga `warn` com `bookingId`, `externalPaymentId` e valor ("pagamento aprovado em reserva expirada, revisar estorno"). Não envia e-mail de confirmação.
  - Vale pra qualquer caminho que receba pagamento aprovado e chame `confirmPaidBooking`: webhook (hoje) e resposta síncrona do `Payment.create` no checkout transparente.
  - Idempotente: redelivery do mesmo webhook não muda nada e não repete o `warn` (a condição `needs_refund_review = false` só casa na primeira vez).
- Consulta que admin/ops usam pra achar os casos: `SELECT b.id, p.external_payment_id, p.amount_cents FROM bookings b JOIN payments p ON p.booking_id = b.id AND p.status = 'approved' WHERE b.needs_refund_review`.
- Estorno automático e aviso ao cliente fora de escopo. A flag não volta pra `false` por código nesta spec; quem fizer o estorno manual decide como registrar isso.

### Pagamento em andamento há mais de 24h

- Reserva `pending` com pagamento em andamento (`pending`/`in_process`) **nunca** é expirada pelo sweeper, nem depois de 24h. O assento continua travado até o webhook final.
- Passadas 24h de `bookings.created_at`, o sweeper alerta **uma única vez** por reserva.
- Como o "uma vez" é garantido: nova coluna `bookings.stale_payment_alerted_at timestamptz NULL`. A cada tick, o sweeper roda um update condicional:

  ```sql
  UPDATE bookings b SET stale_payment_alerted_at = now()
  WHERE b.status = 'pending'
    AND b.stale_payment_alerted_at IS NULL
    AND b.created_at <= now() - interval '24 hours'
    AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('pending', 'in_process'))
  RETURNING b.id;
  ```

  Depois do commit, loga `warn` ("pagamento em andamento há mais de 24h, revisar") com `bookingId` e status do pagamento, uma linha por reserva retornada. Como a coluna já preenchida não casa mais o `WHERE`, os ticks seguintes ignoram a reserva. Com várias instâncias, o `UPDATE` condicional garante que só uma recebe a linha no `RETURNING` (a outra espera o lock da linha, reavalia `stale_payment_alerted_at IS NULL` e não casa), então só uma loga.
- Escolhido em vez de controle em memória ou "logar a cada hora" porque sobrevive a restart e funciona com várias instâncias sem coordenação extra.
- Constante `STALE_PAYMENT_ALERT_HOURS = 24` ao lado de `PENDING_BOOKING_TTL_MINUTES`.

### Front

- Mudança mínima no `CheckoutPage` (`apps/web/src/features/checkout/CheckoutPage.tsx`): quando `createCheckout` (ou `bookSeats`) responder 409 com `code: "BOOKING_EXPIRED"`, mostra a mensagem "Sua reserva expirou. Escolha os assentos novamente." e um botão que leva pra `/sessions/:sessionId/seats`.
- `createCheckout` (`apps/web/src/features/checkout/api.ts`) passa a ler o corpo do erro e lançar um erro tipado (ex: `BookingExpiredError`) nesse caso. Os outros erros seguem a mensagem genérica de hoje.
- No fluxo atual (reserva e checkout no mesmo clique) o 409 de expiração é raro. Ele fica relevante com uma nova tentativa de pagamento na mesma reserva (ver "Relação com outras specs").

### Relação com outras specs

- A spec de checkout transparente (`docs/flows/checkout-transparente/spec.md`, ainda em revisão, fora da `main`) muda duas coisas que tocam esta spec:
  - Webhook `rejected`/`cancelled` **mantém** a reserva `pending` (nova tentativa permitida) e `releaseFailedPaymentBooking` é removido. Esta expiração passa a ser o que libera esses assentos se o cliente desistir. Onde esta spec descreve liberação no `rejected`/`cancelled` (AC13, "Pagamento em andamento", "Mapa e broadcast"), é o comportamento enquanto o Checkout Pro estiver em uso; a spec de checkout transparente o substitui.
  - `payments` vira uma linha por tentativa (`booking_id` deixa de ser único). A regra de "pagamento em andamento" desta spec já usa `EXISTS` sobre qualquer linha da reserva e não muda. A consulta de revisão de estorno (`bookings.status = 'expired' AND payments.status = 'approved'`) também continua valendo.
- Esta spec não depende daquela: vale com o Checkout Pro de hoje e com o checkout transparente.

## Critérios de aceitação

- **AC1**: criar reserva grava `status = "pending"` e `expires_at = created_at + 10 min`, calculado com o relógio do banco.
- **AC2**: o mapa de assentos mostra como `booked` o assento de reserva `pending` dentro do prazo (antes aparecia `free`).
- **AC3**: o mapa de assentos mostra como `free` o assento de reserva `pending` vencida sem pagamento em andamento, mesmo antes do sweeper rodar.
- **AC4**: segurar (hold) assento de reserva `pending` dentro do prazo responde 409. Segurar assento de reserva `pending` vencida sem pagamento em andamento é permitido.
- **AC5**: criar reserva para assento cuja única reserva conflitante é `pending` vencida sem pagamento em andamento funciona (201). Na mesma transação a reserva antiga vira `expired` e todos os `booking_seats` dela são apagados.
- **AC6**: criar reserva para assento com reserva `pending` dentro do prazo continua respondendo 409.
- **AC7**: reserva `pending` vencida com pagamento `in_process` ou `pending` em `payments` continua travando o assento: mapa mostra `booked`, hold responde 409, nova reserva responde 409, e a reserva continua `pending`.
- **AC8**: o sweeper expira reservas `pending` vencidas sem pagamento em andamento: status vira `expired`, `booking_seats` são apagados, e é emitido `seat:update` com `status: "released"` por assento na room da sessão.
- **AC9**: o sweeper não expira nem apaga `booking_seats` de reserva `pending` dentro do prazo, em reserva vencida com pagamento em andamento, nem em reserva `confirmed`/`cancelled`.
- **AC10**: duas execuções do sweeper ao mesmo tempo (simulando duas instâncias) expiram cada reserva uma única vez e emitem um único `released` por assento.
- **AC11**: o sweeper não roda sobreposto na mesma instância: se a execução anterior ainda não terminou, o tick é pulado.
- **AC12**: webhook `approved` para reserva `pending` vencida com pagamento em andamento confirma a reserva normalmente (`confirmed`, broadcast `booked`, e-mail).
- **AC13**: enquanto o Checkout Pro estiver em uso, webhook `rejected` ou `cancelled` para reserva `pending` com pagamento em andamento libera normalmente (`cancelled`, `booking_seats` apagados) e emite `released` por assento. Com o checkout transparente, esta AC é substituída pela daquela spec: a reserva continua `pending` e o assento é liberado pela expiração (AC3, AC5, AC8).
- **AC14**: webhook `approved` para reserva `expired` grava `payments.status = "approved"`, mantém a reserva `expired`, marca `needs_refund_review = true`, não recria `booking_seats`, não envia e-mail e registra log `warn` com `bookingId` e `externalPaymentId`. Redelivery do mesmo webhook não repete o `warn`.
- **AC15**: `POST /bookings/:id/checkout` e `POST /bookings/:id/confirm` respondem 409 com `code: "BOOKING_EXPIRED"` para reserva `expired` e para reserva `pending` com `expires_at` já passado.
- **AC16**: no checkout, um 409 com `code: "BOOKING_EXPIRED"` mostra "Sua reserva expirou. Escolha os assentos novamente." e um botão que leva pra `/sessions/:sessionId/seats`.
- **AC17**: criar reserva emite `seat:update` com `status: "booked"` por assento na room da sessão.
- **AC18**: depois da migration, reserva `pending` criada há mais de 10 min tem `expires_at = created_at + 10 min` e o assento dela aparece `free` no mapa (se não tiver pagamento em andamento). Toda reserva existente fica com `needs_refund_review = false` e `stale_payment_alerted_at = NULL`.
- **AC19**: enquanto o Checkout Pro existir, `POST /bookings/:id/checkout` cria a preferência com `expires: true` e `expiration_date_to` igual ao `expires_at` da reserva.
- **AC20**: reserva `pending` com pagamento em andamento criada há mais de 24h não é expirada pelo sweeper; na primeira execução depois das 24h recebe `stale_payment_alerted_at` e gera um único log `warn`, e as execuções seguintes (inclusive simultâneas, simulando duas instâncias) não alertam de novo.

## Modelo de dados / API (impacto)

- `bookings`: novas colunas `expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')` (backfill `created_at + 10 min`), `needs_refund_review boolean NOT NULL DEFAULT false` e `stale_payment_alerted_at timestamptz NULL`. Novo valor de `status`: `expired` (sem constraint a alterar).
- `POST /bookings/:id/checkout` (Checkout Pro): preferência criada com `expires: true` e `expiration_date_to = booking.expires_at`.
- `payments`: sem mudança de schema nesta spec. Os valores `pending`/`in_process` passam a ter significado na regra de expiração. A regra funciona com uma ou várias linhas por reserva (a spec de checkout transparente remove a unicidade de `booking_id`).
- `POST /sessions/:id/book` e `POST /sessions/:id/seats/:seatId/book`: expiram reservas vencidas conflitantes na mesma transação; emitem `booked` por assento. Contrato de resposta sem mudança.
- `GET /sessions/:id/seats`: `booked` passa a incluir reserva `pending` que ainda trava o assento. `SeatState` sem mudança.
- `POST /sessions/:id/seats/:seatId/hold`: 409 também pra assento de reserva pendente que ainda trava.
- `POST /bookings/:id/checkout` e `POST /bookings/:id/confirm`: novo 409 com `code: "BOOKING_EXPIRED"`.
- `POST /payments/webhook`: `releaseFailedPaymentBooking` passa a emitir `released` (enquanto existir, com Checkout Pro); `confirmPaidBooking` marca `needs_refund_review = true` e loga `warn` quando a reserva está `expired`.
- Nova dependência: `@nestjs/schedule` (versão exata) + `ScheduleModule.forRoot()`.
- Valkey: sem mudança.

## Riscos

- **Clock skew entre instâncias da API**: toda comparação de prazo usa `now()` do Postgres, inclusive no cálculo do `expires_at`. Nenhuma instância decide expiração pelo próprio relógio, então relógios diferentes não geram decisões diferentes.
- **Pagamento em andamento travando assento por muito tempo**: Pix ou boleto `pending`/`in_process` podem segurar o assento por horas ou dias. Decisão: nunca expirar por isso; depois de 24h o sweeper alerta uma única vez (`stale_payment_alerted_at`, AC20) e alguém revisa manualmente. Risco aceito: o assento pode ficar travado até a sessão começar se o Mercado Pago nunca mandar o status final.
- **Pagamento aprovado depois da expiração**: pode acontecer quando o primeiro webhook chega depois dos 10 min (sem linha em `payments` no momento da expiração). Mitigado pela validade da preferência no Mercado Pago (AC19) e tratado com revisão manual via `needs_refund_review` (AC14). Estorno automático fora de escopo.
- **Corrida entre expiração e webhook `in_process`**: o `NOT EXISTS` em `payments` não trava a linha de pagamento. Se o webhook `in_process` chega no mesmo instante da expiração, a reserva pode expirar mesmo assim. Cai no mesmo caminho de "pagamento aprovado depois da expiração" e é aceito como risco baixo.
- **Tentativa ainda sendo enviada ao Mercado Pago não trava** (risco aceito): no checkout transparente, a tentativa fica com status `created` enquanto a chamada ao Mercado Pago não respondeu. `created` não conta como pagamento em andamento, então a reserva pode expirar nesse intervalo. Se esse pagamento depois for aprovado, cai no AC14 (revisão manual de estorno).
- **Cliente voltando do Mercado Pago e pagando de novo**: hoje o `CheckoutPage` cria uma reserva nova a cada clique em "Pagar". Se o cliente volta da página do Mercado Pago e clica de novo dentro dos 10 min, a reserva anterior (dele mesmo) ainda trava os assentos e ele recebe 409. Esta spec não muda isso. Depois dos 10 min a criação preguiçosa resolve sozinha.
- **Dados perdidos da reserva expirada**: `booking_seats` é apagado na expiração (a constraint única é incondicional, então não dá pra manter as linhas). O log `info` do sweeper/criação guarda `bookingId` e assentos, que é o que a revisão manual precisa.
- **Pico de broadcast no deploy**: o backfill pode deixar muitas reservas vencidas de uma vez. O lote de 100 por transação limita o tamanho de cada transação, e os broadcasts saem por room de sessão.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`. Teste de integração/e2e em português, com `// GIVEN`, `// WHEN`, `// THEN`, sem `it.each`, com setup repetitivo (criar reserva vencida, criar `payments`, avançar `expires_at` no banco) em helpers de `apps/api/test/helpers/`. Teste unitário segue o padrão `it("should ...")` com 3A, e `it.each` é bem-vindo.

Pra simular reserva vencida nos testes de integração, o helper ajusta `expires_at` direto no banco (ex: `now() - interval '1 minute'`), em vez de esperar 10 min ou mockar relógio.

| AC | Nível | Teste |
|----|-------|-------|
| AC1 | integração (Jest + Supertest, Postgres/Valkey reais) | `it("AC1: deve criar a reserva pendente com prazo de 10 minutos")` |
| AC2 | integração | `it("AC2: deve mostrar como ocupado o assento de reserva pendente dentro do prazo")` |
| AC3 | integração | `it("AC3: deve mostrar como livre o assento de reserva pendente vencida sem pagamento em andamento")` |
| AC4 | integração | um `it` por caso: `AC4: deve recusar hold em assento de reserva pendente dentro do prazo` e `AC4: deve permitir hold em assento de reserva pendente vencida` |
| AC5 | integração | `it("AC5: deve reservar assento de reserva pendente vencida e marcar a antiga como expirada")` (confere status `expired` e `booking_seats` apagados, inclusive de outros assentos da reserva antiga) |
| AC5 | integração | `it("AC5: deve permitir só uma reserva quando duas pessoas disputam o mesmo assento vencido")` (duas requisições concorrentes: uma 201, outra 409) |
| AC6 | integração | `it("AC6: deve recusar reserva de assento com reserva pendente dentro do prazo")` |
| AC7 | integração | um `it` por status de pagamento e por caminho: mapa, hold e nova reserva com pagamento `in_process`; idem com `pending` |
| AC8 | integração (Postgres + WebSocket reais) | `it("AC8: deve expirar reserva vencida, apagar os assentos e avisar a sala da sessão")` chamando o método do sweeper direto |
| AC9 | integração | um `it` por caso: reserva dentro do prazo, vencida com pagamento em andamento, `confirmed`, `cancelled` |
| AC10 | integração | `it("AC10: deve expirar cada reserva uma única vez com duas execuções simultâneas do sweeper")` (duas instâncias do serviço, `Promise.all`) |
| AC11 | unitário | `should skip the tick while a previous run is still in progress` |
| AC12 | integração | `it("AC12: deve confirmar reserva vencida quando o pagamento em andamento é aprovado")` (mock do cliente do Mercado Pago, como no `payment.e2e-spec.ts`) |
| AC13 | integração | um `it` por status: `rejected` e `cancelled` liberam a reserva e emitem `released` (enquanto o Checkout Pro estiver em uso; removido junto com `releaseFailedPaymentBooking` pela spec de checkout transparente) |
| AC14 | integração | `it("AC14: deve registrar o pagamento aprovado e marcar a reserva expirada para revisão de estorno")` (confere `payments.status = "approved"`, reserva `expired`, `needs_refund_review = true`, sem `booking_seats`, sem e-mail no Mailpit) |
| AC14 | integração | `it("AC14: não deve repetir o alerta de estorno quando o mesmo webhook aprovado chega de novo")` |
| AC14 | unitário | `should flag the booking for refund review and log a warning when an approved payment hits an expired booking` |
| AC15 | integração | um `it` por rota e por caso: checkout e confirm com reserva `expired`; checkout e confirm com reserva `pending` vencida |
| AC16 | componente (Vitest + RTL) | `CheckoutPage` com `createCheckout` respondendo 409 `BOOKING_EXPIRED` mostra a mensagem e o botão leva pra `/sessions/:sessionId/seats` |
| AC16 | unitário | `createCheckout` lança `BookingExpiredError` no 409 com `code: "BOOKING_EXPIRED"` e erro genérico nos outros casos (`it.each`) |
| AC17 | integração (WebSocket real) | `it("AC17: deve avisar a sala da sessão que os assentos foram reservados")` |
| AC18 | integração | `it("AC18: deve tratar como vencida a reserva pendente antiga depois da migration")` (insere reserva com `created_at` antigo e roda o SQL de backfill da migration; confere também `needs_refund_review = false` e `stale_payment_alerted_at` nulo) |
| AC19 | unitário | `should create the preference with expires and expiration_date_to equal to the booking expires_at` (mock do `PREFERENCE_CLIENT`, confere o corpo passado pra `create`) |
| AC19 | integração | `it("AC19: deve criar a preferência do Mercado Pago com validade igual ao prazo da reserva")` (cliente do Mercado Pago mockado, como no `payment.e2e-spec.ts`; compara `expiration_date_to` com `expires_at` lido do banco) |
| AC20 | integração | `it("AC20: deve alertar uma única vez a reserva com pagamento em andamento há mais de 24h sem expirá-la")` (duas execuções seguidas: reserva continua `pending`, `stale_payment_alerted_at` preenchido, um único `warn`) |
| AC20 | integração | `it("AC20: deve alertar uma única vez mesmo com duas execuções simultâneas do sweeper")` |
| — | unitário | helpers de condição (`activeBookingCondition`/`expirableBookingCondition`) e montagem do lote do sweeper, com `it.each` pras combinações de status, prazo e pagamento |
