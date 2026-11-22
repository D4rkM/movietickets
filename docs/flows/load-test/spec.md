# Spec: Teste de carga local (k6)

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...).

## Contexto

Os dashboards do Grafana (métricas de negócio `movietickets.*` e APM/RED, ver `docs/flows/observability/spec.md`) só mostram algo útil com tráfego. Além disso, a regra central do seat hold (vários usuários disputando o mesmo assento, só um ganha) nunca foi exercitada com concorrência real fora dos testes de integração. Esta feature adiciona um script [k6](https://grafana.com/docs/k6/latest/) em `load/` que roda contra a stack local (`make up-full` ou `make up-full-obs`, API em `http://localhost:3000`) pra gerar tráfego realista e validar a disputa por assento.

## Escopo

- Script `load/main.js` com três cenários do k6, selecionáveis por env:
  - `browse`: leitura do catálogo (`GET /movies`) e do mapa de assentos (`GET /sessions/:id/seats`), logado com o cliente seed `cliente@movietickets.dev`.
  - `seat_contention`: N usuários (VUs) tentam segurar o MESMO assento (`POST /sessions/:id/seats/:seatId/hold`) ao mesmo tempo. Esperado: 1 resposta `200`, as demais `409`.
  - `booking_cancel`: hold, reserva (`POST /sessions/:id/seats/:seatId/book`), confirmação simulada (`POST /bookings/:id/confirm`) e cancelamento (`POST /bookings/:id/cancel`), sem pagamento.
- Targets `make load` e `make load-smoke` (este só leitura, 1 VU, 1 iteração).
- `load/README.md`: instalar o k6, rodar, variáveis (`BASE_URL`, `SCENARIOS`, `VUS`, `DURATION`), o que olhar no Grafana e como limpar os dados que sobram.
- `setup()` cria usuários descartáveis (`POST /auth/register`) e escolhe sessão/assentos livres; `teardown()` solta os holds que o teste deixou.

## Fora de escopo

- Qualquer chamada ao Mercado Pago (real ou sandbox). O script nunca chama `POST /bookings/:id/payments`, `GET /bookings/:id/payment-summary` nem `POST /payments/webhook`. Reserva confirmada sem pagamento aprovado cancela sem estorno (`RefundService.cancelWithRefund`, `apps/api/src/refund/refund.service.ts`).
- Rodar em CI: é ferramenta local, sem job na esteira.
- Teste de capacidade/stress de verdade (limites de throughput, ambiente de produção). A carga default é modesta, pensada pro Podman/Docker local.
- WebSocket (Socket.io): o script só usa REST.
- Instalar o k6 como dependência do repo (`package.json`): é um binário externo.

## Decisões e fatos verificados no código

- Hold: `POST /sessions/:id/seats/:seatId/hold`, responde `200` com `{ seatId, status: "held", expiresInSeconds }`; assento segurado por outro usuário ou já reservado responde `409` (`apps/api/src/seating/seating.controller.ts`, `seating.service.ts`). O mesmo usuário segurando de novo recebe `200` (renova TTL), então cada VU precisa de um usuário próprio.
- Reserva: `POST /sessions/:id/seats/:seatId/book` com `{ ticketType: "full" }`, `201` (`apps/api/src/booking/booking.controller.ts`).
- A rota `POST /bookings/:id/confirm` (confirmação simulada) existe hoje sem flag de ambiente (`booking-confirmation.controller.ts`; não há `ENABLE_TEST_ROUTES` no código). Se uma versão futura da API devolver `404` nela, o cenário `booking_cancel` avisa e é pulado sem falhar.
- Cancelar só é permitido até 120 min antes da sessão (`CANCELLATION_DEADLINE_MINUTES`, `booking-lock.ts`), e o seed cria sessões a partir de 1h à frente. Por isso os cenários de escrita só usam sessões que começam daqui a mais de 3h.
- `POST /auth/guest` tem rate limit de 10 por minuto por IP (`guest-token.constants.ts`), então o script usa usuários logados, não convidados.
- k6: `http_req_failed` só conta status fora do esperado porque cada request declara seus status esperados (`responseCallback: http.expectedStatuses(...)`); um `409` no hold não é falha.

## Critérios de aceitação

- **AC1**: Disputa por assento: com N VUs segurando o mesmo assento ao mesmo tempo, exatamente 1 recebe `200` e os outros N-1 recebem `409`; qualquer outro status conta como inesperado. Validado por thresholds do k6 (`contention_hold_won == 1`, `contention_hold_conflict == N-1`, `contention_hold_unexpected == 0`).
- **AC2**: O script nunca chama endpoints de pagamento (`/bookings/:id/payments`, `/bookings/:id/payment-summary`, `/payments/webhook`).
- **AC3**: `make load` e `make load-smoke` falham com mensagem clara (e código de saída diferente de zero) quando o `k6` não está instalado, sem rodar nada.
- **AC4**: `make load-smoke` é só leitura: 1 VU, 1 iteração, só o cenário `browse`, sem registrar usuário nem criar hold ou reserva.
- **AC5**: `booking_cancel` percorre hold, reserva, confirmação simulada e cancelamento sem pagamento; se `POST /bookings/:id/confirm` devolver `404`, o ciclo é pulado com aviso e não reprova o teste.
- **AC6**: Os cenários de escrita só usam sessões que começam daqui a mais de 3h, pra o cancelamento nunca cair no prazo vencido.
- **AC7**: `http_req_failed` só conta status inesperados (o `409` esperado da disputa não reprova) e há threshold de latência p95 (`http_req_duration`).
- **AC8**: `SCENARIOS`, `VUS`, `DURATION` e `BASE_URL` controlam a execução; cenário desconhecido em `SCENARIOS` aborta com mensagem listando os válidos.
- **AC9**: `teardown()` solta os holds que o teste deixou; os dados que sobram (usuários descartáveis, reservas canceladas) e a limpeza estão documentados em `load/README.md`.

## Rastreabilidade com testes

Ferramenta, não código de app: não há teste Jest/Vitest (a regra de teste do `CLAUDE.md` vale pra feature de produto). A validação é o próprio k6: thresholds e `check`s do script (AC1, AC5, AC7), mais verificação manual dos targets do Makefile (AC3, AC4) e do `k6 inspect` (AC8). Os ACs de escrita (AC1, AC5, AC9) só são exercitados quando alguém roda `make load` contra a stack local.
