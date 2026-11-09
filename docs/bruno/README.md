# Bruno collection

`movietickets.json` — export nativo do [Bruno](https://www.usebruno.com/) (cliente de API tipo Postman) com as rotas já implementadas da API. Formato JSON único (não o `.bru` por-arquivo), pra ficar mais simples de importar/gerenciar.

## Importar

Bruno → **Import Collection** → selecionar `docs/bruno/movietickets.json`.

(Diferente de "Open Collection", que espera uma pasta com `bruno.json` — esse arquivo é importado, não aberto.)

## Uso

Fluxo completo, na ordem das pastas da collection:

1. Selecione o environment **local** (`baseUrl` já vem com `http://localhost:3000`).
2. **auth/Register** (opcional, pra criar um usuário novo) e **auth/Login** — usa o admin do `pnpm --filter api db:seed` por padrão (troque pra `cliente@movietickets.dev` pra testar como customer); o `accessToken` retornado é salvo automaticamente na env var `accessToken`.
3. **auth/Guest token** (opcional) — token de convidado (salvo em `guestToken`) pra testar o mapa e os holds sem login: troque o Bearer das rotas de `seating` por `{{guestToken}}`. Mandando `"guestToken": "{{guestToken}}"` no body do Login, os holds do convidado passam pro usuário.
4. **catalog/List movies** — rota pública, lista filmes em cartaz com suas sessões futuras.
5. Rode `pnpm --filter api db:seed` (idempotente) e copie o id da sessão de teste impresso no console pra env var `sessionId` (ou pegue um `id` de sessão do List movies).
6. **seating/Get seat map** — copie o `id` de dois assentos livres da resposta pras env vars `seatId` e `otherSeatId`.
7. **seating/Hold seat** (opcional, mas é o fluxo real do front antes do checkout) — segura `seatId` por 10min no Valkey. **Release seat** / **Release all holds** soltam.
8. Reserva do(s) assento(s):
   - **booking/Book seats (atomic, multiple)** — o que o checkout do front usa de verdade: reserva vários assentos de uma vez, numa transação só (tudo ou nada). Aceita `ticketType: "half"` por assento (exige `halfPriceDocument`).
   - **booking/Book seat (single)** e **booking/Book seat (half price / meia-entrada)** — mesma regra, um assento só.

   O booking nasce `pending` com prazo de 10 min (`expires_at`); o `bookingId` fica salvo na env var.
9. Pagamento, uma das duas opções:
   - **payment/Payment summary** + **payment/Create payment (attempt)** — Checkout Transparente de verdade (sandbox). Precisa de um token de cartão de teste na env var `cardToken` (ver docs do request); na prática é mais simples pagar pelo front.
   - **booking/Confirm booking (mocked payment)** — confirma sem gateway (só pra teste manual/e2e).
10. **booking/Get my bookings** — histórico de ingressos confirmados. **booking/Cancel booking** cancela e libera os assentos.
11. **admin/** — CRUD de filmes, cinemas, salas e sessões; exige o token do admin. Os `Create` salvam o id criado (`movieId`, `cinemaId`, `roomId`, `adminSessionId`) pros requests seguintes da pasta.

**payment/Webhook (simulate)** só funciona com um id real de pagamento do Mercado Pago, porque a API re-busca o pagamento lá.

Cada request novo do backend deve ganhar uma entrada correspondente em `movietickets.json`, na pasta do módulo (`auth`, `seating`, `booking`, `payment`, `admin` etc).

## WebSocket (não coberto pela collection)

Bruno testa só REST — o gateway de realtime (`SeatingGateway`, namespace `/seating`) não aparece em `movietickets.json`. Pra testar manualmente:

1. Conecte com um client socket.io em `{{baseUrl}}/seating`, passando o JWT em `auth: { token: accessToken }` (token do Login ou de convidado). Sem token válido, o servidor desconecta na hora.
2. Emita `join` com o `sessionId` (mesmo da env var) pra entrar na room daquela sessão. `leave` pra sair.
3. Dispare **seating/Hold seat** ou **booking/Confirm booking** numa aba/terminal separado — quem estiver na room recebe um evento `seat:update` (`{ seatId, status: "held" | "released" | "booked", heldByUserId? }`).

Exemplo rápido em Node (`socket.io-client`):

```js
const { io } = require("socket.io-client");
const socket = io("http://localhost:3000/seating", { auth: { token: "<accessToken>" } });
socket.on("connect", () => socket.emit("join", "<sessionId>"));
socket.on("seat:update", console.log);
```
