# Teste de carga (k6)

Script [k6](https://grafana.com/docs/k6/latest/) contra a stack **local** (`make up-full` ou `make up-full-obs`, API em `http://localhost:3000`). Serve pra alimentar os dashboards do Grafana com tráfego e pra exercitar a disputa por assento. Spec: [`docs/flows/load-test/spec.md`](../docs/flows/load-test/spec.md). Não roda em CI e nunca chama o Mercado Pago.

## Instalar o k6

O k6 é um binário externo, não é dependência do repo.

```bash
brew install k6          # macOS
# outros sistemas: https://grafana.com/docs/k6/latest/set-up/install-k6/
```

## Rodar

```bash
make up-full-obs      # stack + Grafana (ou make up-full, sem Grafana)
make load-smoke       # só leitura: 1 VU, 1 iteração, cenário browse
make load             # todos os cenários, carga modesta
```

Variáveis (passam pelo `make`):

| Variável | Default | O que faz |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | URL da API |
| `SCENARIOS` | `browse,seat_contention,booking_cancel` | cenários a rodar, separados por vírgula |
| `VUS` | `10` | VUs da disputa (= número de usuários disputando o assento); `browse` usa no máximo 10 e `booking_cancel` no máximo 3 |
| `DURATION` | `30s` | duração do `browse` |
| `CANCEL_ITERATIONS` | `3` | ciclos de reserva/cancelamento por VU |

```bash
make load SCENARIOS=browse DURATION=2m VUS=5
make load SCENARIOS=seat_contention VUS=20
```

## Cenários

- `browse` (leitura): `GET /movies` e `GET /sessions/:id/seats`, logado com o seed `cliente@movietickets.dev` / `password123` (rode `make seed` antes).
- `seat_contention`: `VUS` usuários descartáveis (registrados no `setup()`) seguram o mesmo assento ao mesmo tempo. Esperado: exatamente 1 `200` e `VUS-1` respostas `409`. Os thresholds `contention_hold_won`, `contention_hold_conflict` e `contention_hold_unexpected` reprovam o teste se a regra quebrar.
- `booking_cancel`: hold, reserva, `POST /bookings/:id/confirm` (confirmação simulada, sem pagamento) e `POST /bookings/:id/cancel`. Sem pagamento aprovado o cancelamento não chama o Mercado Pago. Se a rota de confirmação devolver `404`, o cenário avisa e é pulado.

Os cenários de escrita escolhem uma sessão que começa daqui a mais de 3h (o cancelamento só vale até 2h antes). Se não houver, eles avisam e são pulados (rode `make seed` de novo pra gerar sessões).

## O que olhar no Grafana

`http://localhost:3001` (`admin`/`admin`, só com `make up-full-obs`):

- APM/RED: latência por rota (`http_server_request_duration_seconds_bucket`, rota em formato template como `/sessions/:id/seats`), taxa de erro e duração das queries (`db_client_operation_duration_seconds_bucket`).
- Métricas de negócio `movietickets.*` no Explore (Prometheus): `movietickets_seat_hold_created_total`, `movietickets_seat_hold_rejected_total` (as rejeições da disputa), `movietickets_booking_created_total`, `movietickets_booking_confirmed_total`, `movietickets_booking_cancelled_total`. Os nomes exatos estão em `docs/flows/observability/spec.md`.
- Traces no Tempo: filtre por `service.name = movietickets-api` e abra um `POST .../hold` pra ver Valkey e Postgres.

## Dados que sobram

- O `teardown()` solta os holds do teste. Reservas ficam como `cancelled` (os `booking_seats` são apagados no cancelamento, os assentos voltam a ficar livres).
- Usuários descartáveis (`load-<id>-c-<n>@loadtest.local` e `load-<id>-b-<n>@loadtest.local`) ficam no banco, a API não tem rota pra apagar usuário. Limpeza opcional, com a stack rodando:

```bash
docker compose exec postgres psql -U movietickets -d movietickets -c "DELETE FROM bookings WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'load-%@loadtest.local'); DELETE FROM users WHERE email LIKE 'load-%@loadtest.local';"
```

(troque `docker` por `podman` se for o caso. Se houver tabelas ligadas à reserva, como `refunds`, o `DELETE` pode falhar por chave estrangeira: nesse caso, deixe os dados, são inofensivos.)
- Uma reserva `pending` fica solta só se a confirmação der `404`; ela expira sozinha (sweeper / expiração preguiçosa).

## Aviso

`make load` escreve no banco da stack local. Não rode enquanto estiver testando manualmente nela, nem aponte `BASE_URL` pra um ambiente que não seja descartável.
