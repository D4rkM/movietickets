# Schema do banco (Postgres)

Detalha as tabelas descritas em `docs/planning.md` — colunas, tipos, PK/FK. Sem SQL de migration ainda (entra junto com o scaffold do NestJS/TypeORM ou Prisma, o que for escolhido na implementação).

Convenção: PK `id uuid`, `created_at timestamptz default now()` em todas as tabelas (omitido abaixo pra não repetir).

## Diagrama

Diagrama: [`schema-erd.mmd`](./schema-erd.mmd).

`BOOKING_SEATS` tem `unique (session_id, seat_id)` — não representável na notação do diagrama, mas é a constraint que garante que dois `booking_seats` nunca reservem o mesmo assento na mesma sessão (detalhado na seção da tabela abaixo).

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
| status | text | not null, default `'pending'` (`pending` \| `confirmed` \| `cancelled`) |

## booking_seats

Tabela de junção — **é aqui que mora a constraint crítica que evita double-booking**, não em `bookings`.

| coluna | tipo | notas |
|---|---|---|
| booking_id | uuid FK → bookings.id | not null |
| session_id | uuid FK → sessions.id | not null (denormalizado, necessário pra constraint abaixo) |
| seat_id | uuid FK → seats.id | not null |

Constraint crítica: `unique (session_id, seat_id)` — garante que dois `booking_seats` nunca reservam o mesmo assento na mesma sessão, não importa de qual `booking`.

## payments

| coluna | tipo | notas |
|---|---|---|
| booking_id | uuid FK → bookings.id | not null, unique (1:1 com booking) |
| provider | text | default `'mercado_pago'` |
| external_payment_id | text | id retornado pelo Mercado Pago |
| status | text | not null (`pending` \| `approved` \| `rejected` \| `refunded`) |
| amount_cents | int | not null |

## Fora do Postgres (Valkey)

Hold temporário de assento **não é uma tabela** — vive só no Valkey como chave `seat-hold:{sessionId}:{seatId}` → `{userId}`, com TTL. Nunca é fonte de verdade definitiva; a constraint única em `booking_seats` é quem garante consistência de fato.

## Nota sobre o card [Back] POST simples de reserva de assento (insert MVP)

O insert cru desse card grava em **`bookings` (status `pending`) + um `booking_seats` linkando o assento** — não numa tabela `Booking` sozinha com `seat_id` embutido (isso não existe nesse modelo, já que um booking pode ter vários assentos). Sem constraint de conflito ativa nesse MVP inicial é aceitável, mas o insert já nasce nas tabelas certas.
