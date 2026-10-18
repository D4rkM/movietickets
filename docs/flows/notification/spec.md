# Spec: Notificação por e-mail (confirmação de compra)

> Milestone: AC3 (Notion, Delivery). Os números de AC desta spec são locais à feature — não confundir com o milestone AC3 do Notion.

## Contexto

Ao confirmar um booking, o cliente recebe um e-mail de confirmação. Hoje o envio é síncrono e best-effort: se o SMTP falhar, o e-mail se perde sem retry nem registro. Esta spec move o envio pra um worker assíncrono, com registro em tabela no banco, pra que cada envio seja rastreável e falhas sejam reprocessadas.

## Critérios de aceitação

- **AC1**: confirmar um booking grava uma linha de notificação `pending` na mesma transação da confirmação. Se a confirmação der rollback, nenhuma notificação fica registrada.
- **AC2**: confirmar o mesmo booking duas vezes (ex: webhook redelivery) gera no máximo uma notificação de confirmação para aquele booking.
- **AC3**: o worker reivindica notificações `pending` com lock no banco (`FOR UPDATE SKIP LOCKED`), então duas instâncias do worker nunca enviam a mesma notificação em paralelo.
- **AC4**: envio com sucesso marca a notificação como `sent`, grava `sent_at` e o identificador de mensagem retornado pelo SMTP.
- **AC5**: falha de envio incrementa `attempts`, grava `last_error` e reagenda `next_attempt_at` com backoff exponencial, até `MAX_ATTEMPTS`.
- **AC6**: ao atingir `MAX_ATTEMPTS`, a notificação vai para `failed` e fica visível pra consulta (não é descartada).
- **AC7**: notificação que ficou `sending` além de um tempo limite (worker caiu no meio do envio) volta a ser reivindicável.
- **AC8**: o e-mail mostra a data da sessão no fuso `America/Sao_Paulo`, independente do TZ do processo/container.

## Fora de escopo

- E-mail de cancelamento de ingresso (fica pra outra spec).
- Template HTML e QR code.
- Escolha de provedor SMTP de produção (continua em aberto no planning).
- Exactly-once no e-mail: SMTP não garante isso. A garantia é at-least-once com dedup pela chave `(type, booking_id)` no nosso lado.

## Modelo de dados (rascunho)

Tabela `notifications`:

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `type` | text | `booking_confirmation` (único valor nesta spec) |
| `booking_id` | uuid, FK `bookings.id` | |
| `recipient` | text | e-mail do dono do booking no momento do enqueue |
| `payload` | jsonb | dados já resolvidos (filme, sala, assentos, total) — o worker não re-consulta o booking |
| `status` | text | `pending` / `sending` / `sent` / `failed` |
| `attempts` | int, default 0 | |
| `last_error` | text, nullable | |
| `next_attempt_at` | timestamptz | base do polling |
| `locked_at` | timestamptz, nullable | usado pra AC7 |
| `message_id` | text, nullable | retorno do SMTP |
| `sent_at` | timestamptz, nullable | |
| `created_at` | timestamptz | |

Constraint: unique `(type, booking_id)` — base da AC2.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste de integração/e2e com o número da AC no título do `it`, em português, sem `it.each`:

- AC1 → teste de integração do `BookingService` confirmando booking com Postgres real e checando a linha em `notifications` (e rollback quando a transação falha).
- AC2 → teste de integração: confirmar duas vezes, uma linha só.
- AC3 → teste de integração: dois workers concorrentes, cada notificação enviada uma vez.
- AC4 → teste de integração com SMTP fake (Mailpit) checando `status = sent` e `message_id` preenchido.
- AC5 / AC6 → teste de integração com transport que falha N vezes, checando `attempts`, `next_attempt_at` e `status` final.
- AC7 → teste de integração: linha `sending` com `locked_at` antigo é reprocessada.
- AC8 → teste unitário do formatador de data.
