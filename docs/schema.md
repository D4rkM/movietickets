# Schema do banco (Postgres)

Detalha as tabelas descritas em `docs/planning.md` — colunas, tipos, PK/FK, constraints. Fonte de verdade: `apps/api/src/db/schema.ts` (Drizzle ORM); migrations SQL geradas pelo `drizzle-kit` em `apps/api/drizzle/` (`0000` a `0004` hoje).

Convenção: PK `id uuid`, `created_at timestamptz default now()` em todas as tabelas (omitido abaixo pra não repetir).

## Diagrama

Diagrama: [`schema-erd.mmd`](./schema-erd.mmd).

`BOOKING_SEATS` tem `unique (session_id, seat_id)` — não representável na notação do diagrama, mas é a constraint que garante que dois `booking_seats` nunca reservem o mesmo assento na mesma sessão (detalhado na seção da tabela abaixo). Também ficam de fora do diagrama: o unique parcial de `payments.external_payment_id` e o trigger append-only de `payment_events`.

## users

| coluna | tipo | notas |
|---|---|---|
| name | text | not null |
| email | text | unique, not null |
| password_hash | text | not null |
| role | text | default `'customer'` (`customer` \| `admin`) |

## movies

| coluna | tipo | notas |
|---|---|---|
| title | text | not null |
| synopsis | text | |
| duration_minutes | int | not null |
| poster_url | text | |
| rating | text | classificação indicativa |

## cinemas

Local físico — um mesmo cinema (rede) pode ter várias unidades em endereços diferentes; cada unidade é um `cinema` com suas próprias `rooms`.

| coluna | tipo | notas |
|---|---|---|
| name | text | not null, ex: "Cinema Shopping Centro" |
| address | text | not null |
| city | text | not null — usado pro filtro por cidade/cinema no Catálogo |

## rooms

| coluna | tipo | notas |
|---|---|---|
| cinema_id | uuid FK → cinemas.id | not null |
| name | text | not null, ex: "Sala 1" |
| rows | int | not null |
| seats_per_row | int | not null |

Constraint: `unique (cinema_id, name)` — nome de sala único dentro do mesmo cinema.

## seats

| coluna | tipo | notas |
|---|---|---|
| room_id | uuid FK → rooms.id | not null |
| row_label | text | not null, ex: "A" |
| seat_number | int | not null |

Constraint: `unique (room_id, row_label, seat_number)`.

## sessions

Sessão/horário de exibição (não confundir com sessão de auth).

| coluna | tipo | notas |
|---|---|---|
| movie_id | uuid FK → movies.id | not null |
| room_id | uuid FK → rooms.id | not null |
| starts_at | timestamptz | not null |
| price_cents | int | not null (nunca float pra dinheiro) |

## bookings

Pedido/compra — pode conter vários assentos (via `booking_seats`).

| coluna | tipo | notas |
|---|---|---|
| user_id | uuid FK → users.id | not null |
| session_id | uuid FK → sessions.id | not null |
| status | text | not null, default `'pending'` (`pending` \| `confirmed` \| `cancelled` \| `expired`) — texto livre, sem check constraint no banco |
| expires_at | timestamptz | not null, default `now() + interval '10 minutes'` — prazo do booking `pending`; sempre calculado pelo relógio do banco. Só tem sentido enquanto `status = 'pending'` |
| needs_refund_review | boolean | not null, default `false` — marcado uma vez quando um pagamento `approved` chega num booking já `expired` (estorno manual) |
| stale_payment_alerted_at | timestamptz | nullable — marcado uma vez quando um booking `pending` tem pagamento em andamento (`pending`/`in_process`) há mais de 24h |

Regra de trava de assento (`activeBookingCondition`, `apps/api/src/booking/booking-lock.ts`): um booking trava seus assentos se está `confirmed`, ou `pending` e (dentro do `expires_at` **ou** com pagamento `pending`/`in_process` em andamento). Booking `pending` vencido sem pagamento em andamento vira `expired` (pelo job periódico `PendingBookingSweeper` ou de forma lazy na criação de outro booking) e tem seus `booking_seats` apagados. Spec: `docs/flows/pending-booking-expiry/spec.md`.

## booking_seats

Tabela de junção — **é aqui que mora a constraint crítica que evita double-booking**, não em `bookings`.

| coluna | tipo | notas |
|---|---|---|
| booking_id | uuid FK → bookings.id | not null |
| session_id | uuid FK → sessions.id | not null (denormalizado, necessário pra constraint abaixo) |
| seat_id | uuid FK → seats.id | not null |
| ticket_type | text | not null, default `'full'` (`full` \| `half`, meia-entrada) |
| half_price_document | text | nullable — obrigatório quando `ticket_type = 'half'` (validado na API, não no banco) |
| price_cents | int | not null, default `0` — preço efetivo desse assento, snapshotado no momento da reserva (não recalcula se o preço da sessão mudar depois) |

Constraint crítica: `unique (session_id, seat_id)` — garante que dois `booking_seats` nunca reservam o mesmo assento na mesma sessão, não importa de qual `booking`.

## payments

Uma linha **por tentativa de pagamento** (não mais 1:1 com booking — a unique em `booking_id` caiu na migration `0004`). Spec: `docs/flows/checkout-transparente/spec.md`.

| coluna | tipo | notas |
|---|---|---|
| id | uuid PK | no checkout transparente é o `attemptId` gerado pelo cliente (também usado como `X-Idempotency-Key` no Mercado Pago); linhas criadas só pelo webhook (pagamento legado sem tentativa prévia) usam `gen_random_uuid()` |
| booking_id | uuid FK → bookings.id | not null, index `payments_booking_id_idx` |
| provider | text | not null, default `'mercado_pago'` |
| external_payment_id | text | nullable — id do pagamento no Mercado Pago; unique parcial `payments_external_payment_id_uq` (`WHERE external_payment_id IS NOT NULL`) |
| status | text | not null — estados internos `created` (gravado antes de chamar o MP), `request_failed` (MP recusou a requisição com 4xx), `abandoned` (tentativa `created` parada há mais de 2 min); demais vêm do MP: `pending`, `in_process`, `authorized`, `approved`, `rejected`, `cancelled`, `refunded`, `charged_back`, `in_mediation` |
| status_detail | text | nullable — `status_detail` do MP (vira a mensagem pt-BR pro cliente) |
| amount_cents | int | not null — sempre a soma de `booking_seats.price_cents`, nunca valor vindo do cliente |
| installments | int | nullable |
| payment_method_id | text | nullable (ex: `visa`, `master`) |
| updated_at | timestamptz | not null, default `now()` |

Regra de status: linha `approved` nunca volta pra um status anterior (só `refunded`/`charged_back`/`in_mediation` passam por cima). Pagamento `rejected`/`cancelled` não mexe no booking — ele continua `pending` e aceita nova tentativa até o `expires_at`.

## payment_events

Histórico de auditoria **append-only** dos pagamentos (migration `0004`).

| coluna | tipo | notas |
|---|---|---|
| booking_id | uuid FK → bookings.id | not null |
| payment_id | uuid FK → payments.id | nullable |
| type | text | not null — `attempt_created`, `mp_response`, `mp_request_failed`, `attempt_abandoned`, `webhook_received`, `booking_confirmed` |
| payload | jsonb | not null — só chaves de uma allowlist (`attempt_id`, `mp_payment_id`, `status`, `status_detail`, `amount_cents`, `installments`, `payment_method_id`, `source`, `error_code`); token, CPF, e-mail e nome do titular nunca entram |

Index: `payment_events_booking_id_created_at_idx (booking_id, created_at)`.

Trigger `payment_events_append_only` (`BEFORE UPDATE OR DELETE`, função `forbid_payment_events_mutation()`): qualquer `UPDATE`/`DELETE` na tabela falha com exceção.

## Fora do Postgres (Valkey)

Hold temporário de assento **não é uma tabela** — vive só no Valkey. Nunca é fonte de verdade definitiva; a constraint única em `booking_seats` é quem garante consistência de fato. Chaves (`apps/api/src/seating/hold-keys.ts`):

| chave | valor | notas |
|---|---|---|
| `seat-hold:{sessionId}:{seatId}` | dono do hold: `{userId}` ou `guest:{uuid}` (convidado) | `SET NX` com TTL de 600s; máx. 6 holds por dono por sessão. Expiração vira evento `released` via keyspace notifications (`HoldExpiryListener`) |
| `guest-holds:{guestId}` | set de `{sessionId}:{seatId}` | índice dos holds de um convidado, pra transferir no login sem `SCAN` |
| `guest-consumed:{guestId}` | marcador | token de convidado já usado numa transferência (uso único) |

Não existe cache de catálogo no Valkey hoje (`GET /movies` lê direto do Postgres).
