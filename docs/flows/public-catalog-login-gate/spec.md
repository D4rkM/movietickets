# Spec: Catálogo público + login antes do pagamento

> Milestone: AC3 (Notion, Delivery). Os números de AC desta spec são locais à feature — não confundir com o milestone AC3 do Notion.

## Contexto

Hoje o site exige login pra ver qualquer coisa: `/movies`, mapa de assentos e checkout ficam atrás do `ProtectedRoute`. A página de catálogo passa a ser a apresentação do site: visitante deslogado navega pelos filmes, sessões e mapa, e escolhe assentos. O login só é exigido quando a pessoa avança pro pagamento.

"Escolher o banco" no pedido original é "escolher o assento".

## Escopo

- Catálogo (`/movies`) e página de sessão/assentos (`/sessions/:id/seats`) acessíveis sem login.
- Assento pode ser escolhido logado ou deslogado, com a mesma regra de reserva (hold no Valkey, TTL, limite por sessão).
- Visitante recebe uma identidade de convidado. Os holds dele são transferidos pro usuário quando ele loga.
- Login exigido ao clicar em "Continuar" (antes do checkout).

## Fora de escopo

- Cadastro com redes sociais.
- Carrinho persistido no banco pra visitante.
- Pix.
- Reserva (booking) e pagamento pra convidado: continuam exigindo login.

## Decisões desta spec (pra revisar)

- **Mesma regra de reserva.** Hold é criado no servidor pra visitante e pra usuário logado, com o mesmo `SETNX` + TTL e o mesmo limite de assentos simultâneos por sessão.
- **Identidade de convidado.** `POST /auth/guest` emite um token curto de convidado (JWT com `kind: guest`, `sub: guest:<uuid>`). Esse token só autoriza hold, release e leitura do mapa. Não serve pra booking, pagamento nem ingressos.
- **Transferência no login.** `POST /auth/login` aceita `guestToken` opcional. Se válido, todos os holds do convidado na Valkey passam a ter o `userId` como dono, mantendo o TTL restante. Nenhum assento muda de estado pra outros usuários: continua segurado, só troca o dono.
- **Holder no Valkey.** O valor da chave continua sendo o id do dono (`<uuid>` pro usuário, `guest:<uuid>` pro convidado). O prefixo evita colisão.
- **Seleção restaurada pelo servidor.** Como o hold é real, a seleção volta pela consulta do mapa (`held_by_me`), sem `sessionStorage`.
- **`returnTo` é só do front.** Query param de `/login` pra voltar à página de assentos depois do login. A API nunca recebe esse valor. Aceita só caminho interno (ex: `/sessions/:id/seats`). Qualquer outro valor é descartado, pra evitar open redirect.
- **Usuário logado não muda** no fluxo de clique, só passa a ter o mesmo caminho de reserva que o convidado.

## Critérios de aceitação

- **AC1**: visitante sem login acessa `/movies` e vê filmes com sessões futuras, sem redirecionamento pra login.
- **AC2**: `POST /auth/guest` emite um token de convidado. Token de convidado é aceito em `GET /sessions/:id/seats`, `POST` e `DELETE` de hold, e recusado em `POST /bookings`, `POST /payments` e `GET /bookings/mine` (401).
- **AC3**: visitante clica em assento livre → hold criado com o id do convidado, seat map reflete `held_by_me` pra ele, e broadcast é emitido pros outros clientes da sessão.
- **AC4**: visitante respeita o mesmo limite de assentos simultâneos por sessão que o usuário logado (7º hold é recusado).
- **AC5**: visitante clica em "Continuar" sem login → front vai pra `/login?returnTo=/sessions/:id/seats`. O login envia `guestToken` junto.
- **AC6**: após login com `guestToken` válido, todos os holds do convidado ficam com o `userId` como dono, com o TTL restante preservado. A página de assentos mostra esses assentos como `held_by_me`.
- **AC7**: se algum hold do convidado expirou antes do login, a transferência reporta quais assentos foram perdidos. O front remove esses assentos da seleção e avisa, sem avançar.
- **AC8**: `/checkout` e `/tickets` continuam exigindo login. Acesso direto sem token redireciona pra `/login`.
- **AC9**: `returnTo` aceita só caminho interno. Valor externo (`https://...`, `//...`) é ignorado e o usuário vai pra página padrão.
- **AC10**: token de convidado expirado ou inválido no `guestToken` do login não bloqueia o login. A transferência é pulada e a sessão do usuário é criada normalmente.
- **AC11**: WebSocket aceita handshake com token de convidado pra receber broadcast do mapa de assentos.
- **AC12**: usuário logado clicando em assento continua criando hold e recebendo broadcast (sem regressão do fluxo já entregue).

## Modelo de dados / API (impacto)

- `POST /auth/guest` (novo): sem body, retorna `{ guestToken, expiresAt }`. Token curto (ex: 2h, valor a confirmar).
- `POST /auth/login`: body ganha `guestToken` opcional. Transferência de holds é feita na mesma requisição.
- `GET /sessions/:id/seats`, `POST` e `DELETE` de hold: passam a aceitar token de usuário **ou** de convidado. `held_by_me` é calculado pelo dono atual (usuário ou convidado).
- `POST /bookings`, `POST /bookings/:id/payments`, `GET /bookings/mine`: continuam exigindo token de usuário.
- Gateway WebSocket: handshake aceita token de usuário ou de convidado.
- Schema do banco: sem mudança.

## Riscos em aberto

- Abuso: convidado pode segurar assentos sem limite de convidados. Mitigação proposta: rate limit por IP em `POST /auth/guest` e o mesmo limite de 6 assentos por sessão. Definir valores.
- Token de convidado vazado: só permite hold e release, então o impacto é o convidado segurar/liberar assentos. Mesmo risco de um usuário logado.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`, em português, sem `it.each`:

- AC1 → teste de componente do catálogo sem token + teste e2e (Playwright) navegando como visitante.
- AC2 → teste de integração: token de convidado aceito nos endpoints de assento e recusado nos de reserva/pagamento.
- AC3 → teste de integração: hold de convidado criado e broadcast emitido (Valkey e WebSocket reais).
- AC4 → teste de integração: 7º hold de convidado recusado.
- AC5 / AC6 → teste e2e (Playwright): visitante seleciona, continua, loga e vê os mesmos assentos como `held_by_me`.
- AC7 → teste de integração: hold expirado antes do login é reportado como perdido.
- AC8 → teste de componente de rota protegida sem token.
- AC9 → teste unitário do validador de `returnTo`.
- AC10 → teste de integração: `guestToken` expirado não impede login.
- AC11 → teste de integração do gateway com handshake de convidado.
- AC12 → teste de integração: hold de usuário logado continua sendo criado e emitido por broadcast.
