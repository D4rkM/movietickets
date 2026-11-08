# Spec: Catálogo público + login antes do pagamento

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...) e não têm relação com nenhuma outra numeração externa.

## Contexto

Hoje o site exige login pra ver qualquer coisa: no front, `/movies`, `/sessions/:id/seats`, `/checkout` e `/tickets` ficam todos atrás do `ProtectedRoute` (`apps/web/src/App.tsx`). Na API, `GET /movies` já é público, mas `GET /sessions/:id/seats` e as rotas de hold usam `JwtAuthGuard`. A página de catálogo passa a ser a apresentação do site: visitante deslogado navega pelos filmes, sessões e mapa, e escolhe assentos. O login só é exigido quando a pessoa avança pro pagamento.

Nesta spec, "sessão" é a sessão de cinema (exibição de um filme numa sala e horário, `sessions` no banco), não sessão de login.

## Escopo

- Catálogo (`/movies`) e página de assentos (`/sessions/:id/seats`) acessíveis sem login.
- Assento pode ser escolhido logado ou deslogado, com a mesma regra de hold (Valkey, `SETNX` + TTL de 600s, limite de 6 assentos por sessão).
- Visitante recebe uma identidade de convidado. Os holds dele são transferidos pro usuário quando ele loga.
- Login exigido ao clicar em "Continuar" (antes do checkout).

## Fora de escopo

- Cadastro com redes sociais.
- Carrinho persistido no banco pra visitante.
- Pix.
- Reserva (booking) e pagamento pra convidado: continuam exigindo login de usuário.

## Decisões desta spec

### Identidade de convidado

- `POST /auth/guest` emite um token de convidado: JWT com `kind: "guest"`, `sub: "guest:<uuid>"`, duração de **2h**.
- Reuso: se o front já tem um token de convidado válido (não expirado), reusa. Só pede um novo quando não tem ou quando o atual expirou.
- O token de convidado só autoriza leitura do mapa, hold e release. Não serve pra booking, pagamento nem ingressos.

### Payload do JWT e guards

- `JwtPayload` (`apps/api/src/auth/jwt-payload.type.ts`) ganha `kind: "user" | "guest"`. Token de usuário passa a ser emitido com `kind: "user"` no login.
- Compatibilidade: token sem `kind` (emitido antes desta feature) é tratado como `kind: "user"`. Assim ninguém é deslogado no deploy.
- `JwtAuthGuard` (`apps/api/src/auth/jwt-auth.guard.ts`), que hoje aceita qualquer JWT válido, passa a recusar token `kind: "guest"` com 401. Todas as rotas que já usam esse guard ficam automaticamente fechadas pra convidado.
- Novo guard `UserOrGuestAuthGuard` aceita token de usuário ou de convidado. Usado só nas rotas de assento do `SeatingController`.
- Gateway WebSocket (`apps/api/src/seating/seating.gateway.ts`): o handshake já aceita qualquer JWT válido, então não precisa de mudança de autenticação.

### Hold no Valkey

- Mesma regra pra convidado e usuário: chave `seat-hold:<sessionId>:<seatId>`, valor = id do dono, `SET ... EX 600 NX`, limite `MAX_HELD_SEATS_PER_USER = 6` por sessão (`apps/api/src/seating/seating.service.ts`).
- O prefixo da chave continua `seat-hold`. O que muda é o **valor**: `<uuid>` pro usuário, `guest:<uuid>` pro convidado. O prefixo `guest:` no valor evita colisão entre id de convidado e id de usuário.
- Invariante: um assento numa sessão tem uma única chave de hold, então nunca é segurado por dois donos ao mesmo tempo (vale também durante e depois da transferência).
- Índice do convidado: cada hold de convidado também entra num set `guest-holds:<guestId>` (membros `<sessionId>:<seatId>`), com TTL renovado a cada hold. Release remove o membro. Esse índice permite listar os holds do convidado no login sem `SCAN`. Membro sobrando no índice (hold já expirado) não é problema: a transferência confere o valor da chave antes de mexer.

### Seleção restaurada pelo servidor

Como o hold é real, a seleção volta pela consulta do mapa (`held_by_me`), sem `sessionStorage`.

### Armazenamento do token no front

- Token de convidado fica numa chave separada do `localStorage` (ex: `movietickets:guestToken`), diferente de `movietickets:accessToken`.
- `ProtectedRoute` (`apps/web/src/lib/ProtectedRoute.tsx`) olha só o token de usuário. Ter token de convidado não libera `/checkout` nem `/tickets`.
- Reload ou nova aba reusam o token de convidado guardado enquanto ele for válido.
- Depois do login com transferência bem-sucedida, o front apaga o token de convidado guardado.

### Transferência no login

- `POST /auth/login` aceita `guestToken` opcional. `LoginDto` (`apps/api/src/auth/dto/login.dto.ts`) precisa declarar o campo com `@IsOptional() @IsString()`. Sem isso o `ValidationPipe` com `whitelist: true` (`apps/api/src/main.ts`) remove o campo silenciosamente.
- A senha é validada **antes** da transferência. Login que falha não transfere nada.
- `guestToken` só é considerado se for JWT válido, não expirado, com `kind: "guest"`. Token inválido, expirado ou de `kind: "user"` é ignorado: login funciona, transferência é pulada.
- Mecânica: a API lê `guest-holds:<guestId>` e roda um script Lua atômico na Valkey. Pra cada chave, CAS: só reescreve a chave se o valor atual for o id do convidado, trocando pelo `userId` com `SET ... KEEPTTL` (TTL restante preservado). Chave que não existe mais (expirou) é pulada e reportada como `expired`. Nunca recria hold expirado.
- **Limite na transferência (por sessão).** Se a transferência fizer o usuário passar de 6 holds na mesma sessão, ficam os assentos escolhidos mais recentemente: os holds do convidado (escolha mais recente) são mantidos e os holds **mais antigos** que o usuário já tinha naquela sessão são liberados até o total ficar em 6. A recência vem do TTL restante: todo hold começa com 600s, então `PTTL` maior = hold mais novo. Cada hold liberado gera broadcast `released`. Holds de outras sessões nunca são afetados.
  - Exemplo: convidado com 4 holds e usuário com 4 holds na mesma sessão → mantém os 4 do convidado + os 2 holds mais novos do usuário. Os 2 mais antigos do usuário são liberados.
  - Convidado sozinho com mais de 6 holds numa sessão não acontece, porque o convidado já está sujeito ao mesmo limite.
- **Uso único.** Transferência bem-sucedida consome o `guestToken`: o índice `guest-holds:<guestId>` é apagado e o convidado é marcado como consumido na Valkey (ex: `guest-consumed:<guestId>` com TTL igual ao restante do token). Segundo uso do mesmo `guestToken` cai no caminho do AC10: login funciona, transferência é pulada.
- Resposta do login reporta o resultado pra o front avisar a pessoa:

  ```json
  {
    "accessToken": "...",
    "user": { "...": "..." },
    "transfer": {
      "keptSeats": [{ "sessionId": "...", "seatId": "..." }],
      "releasedSeats": [{ "sessionId": "...", "seatId": "...", "reason": "expired" }]
    }
  }
  ```

  `reason` é `"expired"` (hold do convidado expirou antes do login) ou `"limit"` (hold antigo do usuário liberado pra respeitar o limite de 6). `transfer` só aparece quando um `guestToken` válido foi enviado.

### Broadcast

Toda mudança de hold é emitida pra room inteira da sessão no WebSocket, incluindo o próprio cliente que fez a ação (`server.to(room).emit(...)` no `SeatingGateway`). Na transferência, troca de dono emite `held` com o novo dono, e hold liberado por limite emite `released`.

### `returnTo` é só do front

Query param de `/login` pra voltar à página de assentos depois do login. A API nunca recebe esse valor.

- Destino padrão: `/movies`.
- Aceito só caminho interno começando com uma única `/`. Recusado: `//...`, `\...`, `/\...`, variantes codificadas (`%2F`, `%5C`), URL absoluta (`https://...`, `javascript:...`).
- Validação: resolve o valor com a API `URL` contra uma origem fixa (ex: `new URL(value, "http://app.invalid")`) e confere que a origem resultante é a mesma origem fixa. Qualquer falha → destino padrão.

### Usuário logado

Fluxo de clique não muda. Usuário logado continua criando hold com o mesmo caminho que o convidado.

## Critérios de aceitação

- **AC1**: visitante sem login acessa `/movies` e vê filmes com sessões futuras, sem redirecionamento pra login.
- **AC2**: `POST /auth/guest` emite um token de convidado (`kind: "guest"`, `sub: "guest:<uuid>"`, duração 2h). Token de convidado é aceito em `GET /sessions/:id/seats`, `POST /sessions/:id/seats/:seatId/hold`, `DELETE /sessions/:id/seats/:seatId/hold` e `DELETE /sessions/:id/holds`, e recusado com 401 em `POST /sessions/:id/book`, `POST /sessions/:id/seats/:seatId/book`, `POST /bookings/:id/checkout` (ou `POST /bookings/:id/payments`, se já tiver substituído a rota), `POST /bookings/:id/confirm`, `POST /bookings/:id/cancel` e `GET /bookings/mine`.
- **AC3**: visitante clica em assento livre → hold criado com valor `guest:<uuid>`, o mapa mostra o assento como `held_by_me` pra ele e `held_by_other` pros outros, e o broadcast `held` é emitido pra room da sessão.
- **AC4**: visitante respeita o mesmo limite de 6 assentos simultâneos por sessão que o usuário logado (7º hold na mesma sessão é recusado com 409).
- **AC5**: visitante clica em "Continuar" sem login → front vai pra `/login?returnTo=/sessions/:id/seats`. O login envia o `guestToken` guardado junto.
- **AC6**: após login com `guestToken` válido, todos os holds ainda ativos do convidado passam a ter o `userId` como dono, com o TTL restante preservado (`PTTL` depois da transferência ≤ antes e > 0). A página de assentos mostra esses assentos como `held_by_me`.
- **AC7**: se algum hold do convidado expirou antes do login, a resposta do login traz esse assento em `transfer.releasedSeats` com `reason: "expired"`, e a chave não é recriada. O front mostra um aviso listando os assentos perdidos, remove esses assentos da seleção e mantém a pessoa na página de assentos pra revisar antes de continuar.
- **AC8**: `/checkout` e `/tickets` continuam exigindo login de usuário. Acesso direto sem token de usuário redireciona pra `/login`, mesmo com token de convidado guardado.
- **AC9**: `returnTo` aceita só caminho interno com uma única `/` inicial. `//...`, `\...`, `/\...`, variantes codificadas (`%2F`, `%5C`) e URL absoluta são ignorados, e a pessoa vai pra `/movies`.
- **AC10**: `guestToken` expirado, inválido, já usado numa transferência anterior, ou com `kind: "user"` não bloqueia o login. A transferência é pulada e a sessão do usuário é criada normalmente.
- **AC11**: WebSocket aceita handshake com token de convidado, e um cliente convidado que entrou na room da sessão recebe o broadcast quando outro cliente segura ou libera um assento.
- **AC12**: usuário logado clicando em assento continua criando hold e recebendo broadcast (sem regressão do fluxo já entregue).
- **AC13**: transferência que faria o usuário passar de 6 holds numa sessão mantém os holds do convidado e libera os holds mais antigos (menor `PTTL`) que o usuário já tinha naquela sessão até o total ficar em 6. Os liberados vêm em `transfer.releasedSeats` com `reason: "limit"`, geram broadcast `released`, e holds do usuário em outras sessões não mudam. O front mostra aviso listando os assentos liberados.
- **AC14**: login com senha errada e `guestToken` válido não transfere nada: os holds continuam com o convidado.
- **AC15**: página de assentos aberta sem token de usuário obtém (ou reusa, se o guardado ainda for válido) o token de convidado antes de ler o mapa. Reload e nova aba reusam o mesmo token enquanto ele for válido.
- **AC16**: se `POST /auth/guest` falhar, a página de assentos mostra mensagem de erro com botão de tentar de novo, e o mapa não fica interativo até obter o token.
- **AC17**: token de usuário emitido antes desta feature (sem `kind`) continua aceito nas rotas de usuário, tratado como `kind: "user"`.

## Modelo de dados / API (impacto)

- `POST /auth/guest` (novo, público): sem body, retorna `{ guestToken, expiresAt }`. Token de 2h. Rate limit de 10 requisições/min por IP.
- `POST /auth/login`: `LoginDto` ganha `guestToken` opcional (`@IsOptional() @IsString()`). Token de usuário emitido com `kind: "user"`. Resposta ganha `transfer` opcional (`keptSeats`, `releasedSeats` com `reason`). Transferência feita na mesma requisição, depois da validação de senha.
- `JwtPayload`: ganha `kind: "user" | "guest"` (ausente = `user`).
- `JwtAuthGuard`: recusa `kind: "guest"` com 401.
- `UserOrGuestAuthGuard` (novo): usado só em `GET /sessions/:id/seats`, `POST /sessions/:id/seats/:seatId/hold`, `DELETE /sessions/:id/seats/:seatId/hold` e `DELETE /sessions/:id/holds`. `held_by_me` é calculado pelo dono atual (usuário ou convidado).
- Continuam com `JwtAuthGuard` (só usuário): `POST /sessions/:id/book`, `POST /sessions/:id/seats/:seatId/book`, `POST /bookings/:id/checkout`, `POST /bookings/:id/confirm`, `POST /bookings/:id/cancel`, `GET /bookings/mine`.
  - Dependência: há um PR planejado que substitui `POST /bookings/:id/checkout` por `POST /bookings/:id/payments`. A regra vale pras duas: a que existir quando esta feature for implementada fica com `JwtAuthGuard` e entra no teste do AC2.
- Valkey: chave `seat-hold:<sessionId>:<seatId>` sem mudança de formato. Novos: set `guest-holds:<guestId>` (índice de holds do convidado, com TTL) e `guest-consumed:<guestId>` (marca de uso único).
- Gateway WebSocket: sem mudança de autenticação (handshake já aceita qualquer JWT válido).
- Schema do banco: sem mudança.

## Riscos

- **Abuso de convidado**: alguém pode criar muitos convidados e segurar muitos assentos. Mitigação: rate limit de 10 requisições/min por IP em `POST /auth/guest`, o mesmo limite de 6 assentos por sessão por convidado, e TTL de 600s em cada hold.
- **Token de convidado vazado**: só permite ler o mapa, segurar e liberar assentos do próprio convidado. Mesmo impacto de um usuário logado segurando assentos, sem acesso a reserva, pagamento ou ingressos. Duração de 2h limita a janela.
- **Replay de `guestToken`**: alguém que obtenha o `guestToken` depois do login não consegue usá-lo pra puxar holds pra outra conta, porque o token é de uso único (consumido na primeira transferência bem-sucedida).

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`. Teste de integração/e2e em português, com `// GIVEN`, `// WHEN`, `// THEN`, sem `it.each`. Teste unitário segue o padrão `it("should ...")` com 3A.

| AC | Nível | Teste |
|----|-------|-------|
| AC1 | componente (Vitest + RTL) + e2e (Playwright) | catálogo renderiza sem token; visitante navega por `/movies` sem redirecionamento |
| AC2 | integração (Jest + Supertest, Postgres/Valkey reais) | um `it` por rota: token de convidado aceito nas 4 rotas de assento; um `it` por rota: recusado com 401 nas rotas de booking, checkout/payments, confirm, cancel e `GET /bookings/mine` |
| AC2 | unitário | `JwtAuthGuard` recusa `kind: "guest"`; `UserOrGuestAuthGuard` aceita os dois |
| AC3 | integração | hold de convidado criado com valor `guest:<uuid>`, mapa mostra `held_by_me` pra ele e `held_by_other` pra outro, broadcast `held` emitido (Valkey e WebSocket reais) |
| AC4 | integração | 7º hold de convidado na mesma sessão recusado com 409 |
| AC5 | componente + e2e | "Continuar" sem token de usuário navega pra `/login?returnTo=...`; login envia `guestToken` |
| AC6 | integração | holds do convidado passam pro `userId`; `PTTL` depois ≤ antes e > 0 |
| AC6 | e2e | visitante seleciona, continua, loga e vê os mesmos assentos como `held_by_me` |
| AC7 | integração | hold expirado antes do login vem em `releasedSeats` com `reason: "expired"` e a chave não é recriada |
| AC7 | componente | aviso lista os assentos perdidos, remove da seleção e a página fica nos assentos |
| AC8 | componente | `ProtectedRoute` redireciona sem token de usuário, mesmo com token de convidado guardado |
| AC9 | unitário | validador de `returnTo` (aqui `it.each` é bem-vindo: `//`, `\`, `/\`, `%2F`, `%5C`, URL absoluta, caminho válido, vazio) |
| AC10 | integração | um `it` por caso: `guestToken` expirado, inválido, já usado, e de `kind: "user"` não impedem o login e não transferem nada |
| AC11 | integração | gateway aceita handshake de convidado e o cliente convidado recebe broadcast de hold/release feito por outro cliente |
| AC12 | integração | hold de usuário logado continua sendo criado e emitido por broadcast |
| AC13 | integração | convidado 4 + usuário 4 na mesma sessão: mantém 4 do convidado + 2 mais novos do usuário, libera 2 mais antigos com `reason: "limit"` e broadcast `released` |
| AC13 | integração | holds do usuário em outra sessão não são afetados pela transferência |
| AC13 | componente | aviso lista os assentos liberados por limite |
| AC14 | integração | senha errada com `guestToken` válido não transfere holds |
| AC15 | componente | página de assentos sem token de usuário chama `POST /auth/guest` antes de ler o mapa; com token de convidado válido guardado, reusa sem chamar |
| AC16 | componente | falha em `POST /auth/guest` mostra erro com "tentar de novo" e mapa não interativo |
| AC17 | integração | token de usuário sem `kind` continua aceito em `GET /bookings/mine` |
| — | unitário | script Lua de transferência / serviço de transferência: CAS, `KEEPTTL`, ordenação por `PTTL` pro limite |
