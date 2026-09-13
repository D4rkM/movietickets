# Bruno collection

`movietickets.json` — export nativo do [Bruno](https://www.usebruno.com/) (cliente de API tipo Postman) com as rotas já implementadas da API. Formato JSON único (não o `.bru` por-arquivo), pra ficar mais simples de importar/gerenciar.

## Importar

Bruno → **Import Collection** → selecionar `docs/bruno/movietickets.json`.

(Diferente de "Open Collection", que espera uma pasta com `bruno.json` — esse arquivo é importado, não aberto.)

## Uso

1. Selecione o environment **local** (`baseUrl` já vem com `http://localhost:3000`).
2. Rode **auth/Login** (usa o admin do `pnpm --filter api db:seed`) ou **auth/Register** — o `accessToken` retornado é salvo automaticamente na env var `accessToken`.
3. Rode `pnpm --filter api db:seed` (idempotente) e copie o id da sessão de teste impresso no console pra env var `sessionId` (ver detalhes na doc do request **seating/Get seat map** — ainda não existe endpoint de criação de sessão via API, por isso o seed cobre isso).
4. Rode **seating/Get seat map** e copie o `id` de um assento livre da resposta pra env var `seatId`.
5. Rode **booking/Book seat (MVP insert)**.

Cada request novo do backend deve ganhar uma entrada correspondente em `movietickets.json`, na pasta do módulo (`auth`, `seating`, `booking`, etc).
