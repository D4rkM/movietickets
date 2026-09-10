# Bruno collection

Collection do [Bruno](https://www.usebruno.com/) (cliente de API tipo Postman, mas os arquivos `.bru` ficam versionados no repo) com as rotas já implementadas da API.

## Abrir

Bruno → "Open Collection" → selecionar `docs/bruno/movietickets`.

## Uso

1. Selecione o environment **local** (`http://localhost:3000` por padrão).
2. Rode **auth/Login** (usa o admin do `pnpm --filter api db:seed`) ou **auth/Register** — o `accessToken` retornado é salvo automaticamente na env var `accessToken`.
3. Preencha a env var `sessionId` (ver instruções no próprio request **seating/Get seat map**, já que ainda não existe endpoint de criação de sessão).
4. Rode **seating/Get seat map**.

Cada request novo do backend deve ganhar um `.bru` correspondente aqui, na mesma pasta do módulo (`auth/`, `seating/`, etc).
