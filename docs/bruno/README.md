# Bruno collection

`movietickets.json` — export nativo do [Bruno](https://www.usebruno.com/) (cliente de API tipo Postman) com as rotas já implementadas da API. Formato JSON único (não o `.bru` por-arquivo), pra ficar mais simples de importar/gerenciar.

## Importar

Bruno → **Import Collection** → selecionar `docs/bruno/movietickets.json`.

(Diferente de "Open Collection", que espera uma pasta com `bruno.json` — esse arquivo é importado, não aberto.)

## Uso

Fluxo completo, na ordem das pastas da collection:

1. Selecione o environment **local** (`baseUrl` já vem com `http://localhost:3000`).
2. **auth/Register** (opcional, pra criar um usuário novo) e **auth/Login** — usa o cliente/admin do `pnpm --filter api db:seed` por padrão; o `accessToken` retornado é salvo automaticamente na env var `accessToken`.
3. **catalog/List movies** — rota pública, lista filmes em cartaz com suas sessões futuras. Não exige nenhuma env var extra.
4. Rode `pnpm --filter api db:seed` (idempotente) e copie o id da sessão de teste impresso no console pra env var `sessionId` (ainda não existe endpoint de criação de sessão via API, por isso o seed cobre isso).
5. **seating/Get seat map** — copie o `id` de dois assentos livres da resposta pras env vars `seatId` e `otherSeatId`.
6. **seating/Hold seat** (opcional, mas é o fluxo real do front antes do checkout) — segura `seatId` por 10min no Valkey. Reenviar renova o TTL; 409 se já estiver held por outro usuário/já reservado/limite de 6 assentos atingido.
7. Reserva do(s) assento(s) — três opções, dependendo do que quer testar:
   - **booking/Book seats (atomic, multiple)** — o que o checkout do front usa de verdade: reserva vários assentos de uma vez, numa transação só (tudo ou nada). Aceita `ticketType: "half"` por assento (exige `halfPriceDocument`).
   - **booking/Book seat (MVP insert)** — assento único, sem checagem de conflito (o insert original, mantido pra referência histórica do MVP).
   - **booking/Book seat (half price / meia-entrada)** — mesma rota de assento único, com `ticketType: "half"`.
8. **booking/Confirm booking (mocked payment)** — o `bookingId` da reserva já fica salvo automaticamente na env var; confirma o pagamento mockado e marca o(s) assento(s) como `booked`.
9. **booking/Get my bookings** — lista o histórico de ingressos confirmados do usuário autenticado.

Cada request novo do backend deve ganhar uma entrada correspondente em `movietickets.json`, na pasta do módulo (`auth`, `seating`, `booking`, etc).

## WebSocket (não coberto pela collection)

Bruno testa só REST — o gateway de realtime (`SeatingGateway`, namespace `/seating`) não aparece em `movietickets.json`. Pra testar manualmente:

1. Conecte com um client socket.io em `{{baseUrl}}/seating`, passando o JWT em `auth: { token: accessToken }` (mesmo token do Login/Register). Sem token válido, o servidor desconecta na hora.
2. Emita `join` com o `sessionId` (mesmo da env var) pra entrar na room daquela sessão. `leave` pra sair.
3. Dispare **seating/Hold seat** ou **booking/Confirm booking** numa aba/terminal separado — quem estiver na room recebe um evento `seat:update` (`{ seatId, status: "held" | "booked", heldByUserId? }`).

Exemplo rápido em Node (`socket.io-client`):

```js
const { io } = require("socket.io-client");
const socket = io("http://localhost:3000/seating", { auth: { token: "<accessToken>" } });
socket.on("connect", () => socket.emit("join", "<sessionId>"));
socket.on("seat:update", console.log);
```
