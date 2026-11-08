# Spec: Painel admin (CRUD de filmes, salas e sessões)

> Os números de AC desta spec são locais à feature (`AC1`, `AC2`, ...) e não têm relação com nenhuma outra numeração externa.

## Contexto

Hoje o catálogo só tem o que o seed (`apps/api/src/db/seed.ts`) insere direto no banco. Não existe nenhuma rota de escrita pra filmes, salas ou sessões, e nada na API olha pra `users.role`, apesar de o JWT já carregar `role` (`apps/api/src/auth/jwt-payload.type.ts`). O painel admin dá a quem tem `role = "admin"` um jeito de cadastrar e manter filmes, salas e sessões sem SQL, com formulários simples e sem UI sofisticada (`docs/planning.md`, seção "5. Painel admin").

Nesta spec, "sessão" é a sessão de cinema (exibição de um filme numa sala e horário, `sessions` no banco), não sessão de login.

## Escopo

- CRUD de filmes (`movies`).
- CRUD de salas (`rooms`), com geração automática dos assentos (`seats`) a partir de `rows × seatsPerRow`.
- CRUD de sessões (`sessions`), com recusa de sobreposição na mesma sala.
- Listar, criar e editar cinemas (`cinemas`). Sem exclusão.
- Regras de integridade que impedem apagar ou alterar o que já tem reserva, hold ou histórico.
- Autorização por papel: só `role = "admin"` acessa `/admin/*`.
- Área `/admin` no front, com páginas de lista + formulário e rota protegida por papel.

## Fora de escopo

- Soft delete / desativar filme, sala ou sessão (ex: coluna `active`). Nesta versão, o que tem dependência é bloqueado com 409 e o resto é apagado de verdade.
- Excluir cinema (ver "Decididas").
- Layout de sala irregular (fileiras com quantidades diferentes, corredores configuráveis, assento PCD). A sala gerada pelo admin é sempre retangular. O layout irregular da sala de exemplo do seed continua existindo só via seed.
- Upload de pôster (o admin informa uma URL em `posterUrl`).
- Gestão de usuários pela API (promover/rebaixar admin, listar usuários). Um endpoint pra admin promover outros usuários pode vir numa feature futura. Nesta versão, promoção é só por SQL manual (ver "Decididas").
- Cancelar sessão que já vendeu ingresso (soft delete + reembolso dos ingressos). Fica pra uma feature futura separada.
- Expiração automática de booking `pending`. Definida e implementada na spec `docs/flows/pending-booking-expiry/spec.md`. Esta spec só reaproveita a regra de lá (ver "Decididas").
- Intervalo de limpeza/trailer entre sessões na mesma sala (ver "Decididas").
- Paginação, busca e ordenação configurável nas listas do admin.
- Relatórios (vendas, ocupação).
- Auditoria de quem alterou o quê.

## Decisões desta spec

> A subseção "Decididas" já foi confirmada. As subseções marcadas **(pra revisar)** ainda são propostas e podem mudar na revisão.

### Decididas

- **Intervalo entre sessões: 0 min.** Na mesma sala, uma sessão pode começar exatamente quando a anterior termina (`startsAt + duração do filme`). Sem tempo de limpeza ou trailer nesta versão. Se precisar depois, vira uma constante configurável somada ao fim de cada sessão na checagem de sobreposição, sem mudar a regra do AC14.
- **`rating` validado.** Se informado, precisa ser um de `L`, `10`, `12`, `14`, `16`, `18` (classificação indicativa brasileira). Outro valor → 400. Continua opcional.
- **Booking `pending` só conta como atividade enquanto ainda trava assentos.** A expiração de `pending` está em `docs/flows/pending-booking-expiry/spec.md` (já implementada). Esta spec usa a mesma regra única de lá (`activeBookingCondition`, em `apps/api/src/booking/booking-lock.ts`): um booking `pending` trava assentos enquanto está dentro do `expires_at` ou tem pagamento `pending`/`in_process`. Só nesse caso ele bloqueia a edição da sessão. Booking `pending` vencido sem pagamento em andamento, `expired` e `cancelled` não bloqueiam edição, porque não travam mais nenhum assento. Na exclusão, **qualquer** booking bloqueia, em qualquer status (inclusive `expired`), porque é histórico (ver AC17).
- **Preço com só booking `confirmed` pode mudar.** O preço pago já fica gravado por assento em `booking_seats.price_cents` (e é ele que vai pro pagamento), então mudar `priceCents` da sessão não afeta quem já comprou. Mudar preço continua bloqueado (409) quando houver booking `pending` que ainda trava assentos ou hold ativo: quem está no meio da compra viu um preço e não pode ser surpreendido no checkout.
- **Cancelar sessão que já vendeu ingresso** (soft delete + reembolso) fica fora de escopo. Será uma feature separada no futuro.
- **Exclusão de cinema** fica fora de escopo. Listar, criar e editar bastam.
- **Fuso do formulário de sessão fixo em `America/Sao_Paulo`.** O front mostra e recebe o horário de sessão nesse fuso, independente do fuso do navegador, e envia `startsAt` em ISO 8601 com offset. A API grava em `timestamptz` (UTC) como já faz hoje. As listas do admin também mostram o horário em `America/Sao_Paulo`.

#### Primeiro admin

- Dev/local: o seed já cria `admin@movietickets.dev` com `role: "admin"` (senha de dev `password123`). Nada muda.
- Outros ambientes: o admin é promovido por SQL manual, documentado no `apps/api/README.md` como parte da implementação:

  ```sql
  UPDATE users SET role = 'admin' WHERE email = '<email>';
  ```

  Depois disso, a pessoa precisa logar de novo pra receber um token com `role: "admin"`.
- `POST /auth/register` continua criando sempre `role: "customer"`. O `RegisterDto` não declara `role` e o `ValidationPipe` (`whitelist: true`) remove o campo, então mandar `role: "admin"` no body não promove ninguém. Isso vira AC pra não regredir.
- Sem script, sem endpoint de promoção e sem variável de ambiente de bootstrap (ex: `ADMIN_EMAIL`) nesta versão. Um endpoint pra admin promover outros usuários pode vir numa feature futura (ver "Fora de escopo").

### Escopo do MVP e cinemas (pra revisar)

- Entram filmes, salas e sessões, como no `docs/planning.md`.
- Cinemas entram só com listar, criar e editar (`name`, `address`, `city`). Motivo: sala exige `cinemaId` (`rooms.cinema_id` é `NOT NULL`), então sem criar cinema o admin só consegue pôr sala nova nos cinemas que o seed criou. É trivial (três campos de texto, sem regra de negócio).

### Autorização (pra revisar)

- Novo decorator `@Roles("admin")` + `RolesGuard` em `apps/api/src/auth/`. O guard lê `request.user.role`, que o `JwtAuthGuard` já preenche com o payload do token. Hoje não existe nenhum guard de papel na API.
- Todas as rotas do `AdminModule` ficam em `/admin/*` e usam `@UseGuards(JwtAuthGuard, RolesGuard)` no nível do controller, com `@Roles("admin")`.
- Sem token, token inválido ou expirado → 401 (comportamento atual do `JwtAuthGuard`).
- Token de usuário com `role` diferente de `"admin"` → 403.
- Token de convidado (`kind: "guest"`, introduzido pela spec `docs/flows/public-catalog-login-gate/spec.md`) → 401, porque o `JwtAuthGuard` já recusa convidado depois daquela feature. Se esta feature for implementada antes da identidade de convidado, essa regra vale assim que o convidado existir, e o teste do AC3 entra junto com ela.
- O papel vem do token, sem consulta ao banco por requisição. Consequência: quem perde o papel admin continua com acesso até o token expirar (`JWT_EXPIRES_IN`, padrão `1h`). Aceito nesta versão (ver "Riscos").
- O `GET /movies` público continua sem guard. As rotas admin não reutilizam o `CatalogController`.

### Filmes (pra revisar)

- Campos: `title` (obrigatório, 1–200 caracteres), `synopsis` (opcional), `durationMinutes` (obrigatório, inteiro 1–600), `posterUrl` (opcional, URL `http`/`https`), `rating` (opcional; se informado, um de `L`, `10`, `12`, `14`, `16`, `18`, ver "Decididas").
- Exclusão: só se o filme não tiver **nenhuma** sessão (passada ou futura). Com sessão → 409. Motivo: `sessions.movie_id` é FK sem `ON DELETE`, então o banco já recusaria. A checagem explícita devolve 409 com mensagem clara em vez de 500.
- Editar `durationMinutes` revalida a sobreposição de todas as sessões futuras do filme. Se a nova duração fizer alguma sessão invadir a seguinte na mesma sala → 409 e nada muda.

### Salas e assentos (pra revisar)

- Campos: `cinemaId` (obrigatório, cinema existente), `name` (obrigatório), `rows` (inteiro 1–26), `seatsPerRow` (inteiro 1–40).
- `rows` vai até 26 porque o rótulo da fileira é uma letra (`A`, `B`, ...), mesmo padrão do seed (`String.fromCharCode(65 + rowIndex)`).
- Criar sala gera `rows × seatsPerRow` assentos na mesma transação: fileiras `A`..., assentos numerados de `1` a `seatsPerRow`.
- Nome duplicado no mesmo cinema → 409 (o banco já tem `unique(cinema_id, name)`).
- Editar `name` é sempre permitido (respeitando a unicidade).
- Mudar `rows` ou `seatsPerRow` apaga e regera os assentos na mesma transação, e só é permitido se a sala não tiver **nenhuma** sessão (passada ou futura). Com sessão → 409. Motivo: assento é referenciado por `booking_seats.seat_id` e por chaves de hold no Valkey. Trocar os assentos de uma sala com sessão quebraria reservas, holds e o mapa.
- Excluir sala: só sem nenhuma sessão (mesma razão de FK de `sessions.room_id`). Apaga assentos e sala na mesma transação. Com sessão → 409.
- Mudar o cinema da sala (`cinemaId`) não é permitido na edição. Se precisar, apaga e cria outra.

### Sessões (pra revisar)

- Campos: `movieId` (filme existente), `roomId` (sala existente), `startsAt` (ISO 8601 com offset, precisa ser futuro, gravado em UTC), `priceCents` (inteiro > 0).
- **Sobreposição.** O schema tem `movies.duration_minutes`, então o intervalo de uma sessão é `[startsAt, startsAt + movie.durationMinutes)`. Duas sessões na mesma sala se sobrepõem quando `A.start < B.end` e `B.start < A.end`. Sobreposição → 409. Sessão que começa exatamente quando a outra termina não é sobreposição. Sem intervalo de limpeza entre sessões (ver "Decididas").
- A checagem de sobreposição vale pra criar sessão, editar `roomId`/`startsAt`/`movieId` e editar `durationMinutes` de filme. Sessões passadas também entram na conta (uma sessão nova não pode começar no meio de outra que já começou).
- **Concorrência.** Duas criações simultâneas que se sobrepõem não podem passar as duas. A checagem e o insert/update rodam numa transação que trava a linha da sala (`SELECT ... FROM rooms WHERE id = $1 FOR UPDATE`) antes de ler as sessões dela. Exclusion constraint do Postgres (`tstzrange` + `btree_gist`) foi descartada porque a duração mora em `movies`, não em `sessions`.
- **Sessão já iniciada** (`startsAt <= agora`) é só leitura: edição e exclusão → 409.
- **Atividade de compra.** Uma sessão tem atividade se tiver booking `confirmed`, booking `pending` que ainda trava assentos (dentro do `expires_at` ou com pagamento `pending`/`in_process`, mesma regra de `docs/flows/pending-booking-expiry/spec.md`) ou hold ativo no Valkey (chaves `seat-hold:<sessionId>:*`, mesma varredura que o `SeatingService.scanHoldKeys` já faz). Booking `pending` vencido sem pagamento em andamento, `expired` e `cancelled` não são atividade.
  - Com qualquer atividade, editar `movieId`, `roomId` ou `startsAt` → 409.
  - `priceCents`: com booking `pending` que ainda trava assentos ou hold ativo → 409. Com só booking `confirmed` (sem `pending` ativo e sem hold) → permitido, porque o preço pago está gravado em `booking_seats.price_cents` (ver "Decididas").
- **Exclusão de sessão.** Bloqueada (409) se houver hold ativo ou **qualquer** booking, em qualquer status (inclusive `cancelled`, `expired` e `pending` vencido). Motivo: `bookings.session_id` e `booking_seats.session_id` são FK sem `ON DELETE`, e booking cancelado ou expirado guarda histórico de pagamento (`payments`). Apagar em cascata perderia esse histórico.
- Sessão sem booking e sem hold é apagada de verdade.

### Cache do catálogo (pra revisar)

- Hoje o `CatalogService.listMovies` (`apps/api/src/catalog/catalog.service.ts`) consulta o Postgres direto. **Não existe cache Valkey no `GET /movies`**, apesar de o `docs/planning.md` citar "cache Valkey" no `CatalogModule`. Então nesta versão não há nada pra invalidar.
- Regra pra frente: se um cache for adicionado no catálogo, toda escrita do admin (filme, sala, cinema, sessão) invalida as chaves do catálogo na mesma requisição, depois do commit. Os ACs 4, 12 e 17 checam que o catálogo reflete a escrita imediatamente, então pegam a regressão se alguém adicionar cache sem invalidar.

### Listas do admin (pra revisar)

- `GET /admin/movies`: todos os filmes, ordem por título.
- `GET /admin/cinemas`: todos os cinemas, ordem por nome.
- `GET /admin/rooms`: todas as salas com nome do cinema, ordem por cinema e nome. Aceita `?cinemaId=`.
- `GET /admin/sessions`: sessões futuras por padrão, ordem por `startsAt`, com título do filme, sala e cinema. `?includePast=true` inclui as passadas.
- Sem paginação nesta versão.

### Front (pra revisar)

- Rotas novas em `apps/web/src/App.tsx`, todas dentro de um novo `AdminRoute`:
  - `/admin` (índice com links pras seções)
  - `/admin/movies`, `/admin/movies/new`, `/admin/movies/:id`
  - `/admin/cinemas`, `/admin/cinemas/new`, `/admin/cinemas/:id`
  - `/admin/rooms`, `/admin/rooms/new`, `/admin/rooms/:id`
  - `/admin/sessions`, `/admin/sessions/new`, `/admin/sessions/:id`
- `AdminRoute` (`apps/web/src/lib/AdminRoute.tsx`): sem token de usuário → `/login`. Com token, mas `user.role !== "admin"` (lido do `AuthContext`, que já guarda `role` em `movietickets:user`) → tela "Acesso restrito" com link pra `/movies`. A checagem no front é só de navegação. Quem protege de verdade é a API.
- Link "Admin" no `ProfileMenu` (`apps/web/src/features/auth/ProfileMenu.tsx`) só aparece pra `role === "admin"`.
- Páginas de lista: tabela simples com os campos principais, botão "Novo", "Editar" e "Excluir" (confirmação com `window.confirm`).
- Formulários: inputs nativos (`text`, `number`, `datetime-local`, `select`), sem biblioteca de formulário nova. Preço digitado em reais e convertido pra centavos. `startsAt` digitado e exibido em `America/Sao_Paulo` (não no fuso do navegador) e enviado em ISO 8601 com offset (ver "Decididas").
- Erro da API (400, 404, 409) aparece no formulário com a mensagem retornada, sem perder o que foi digitado.
- 401 numa chamada admin segue o comportamento atual do `api-client` (limpa a sessão e manda pro login).

## Critérios de aceitação

- **AC1**: qualquer rota `/admin/*` chamada sem token, com token inválido ou com token expirado responde 401.
- **AC2**: qualquer rota `/admin/*` chamada com token de usuário `role: "customer"` responde 403 e não altera nada no banco.
- **AC3**: qualquer rota `/admin/*` chamada com token de convidado (`kind: "guest"`) responde 401.
- **AC4**: admin cria um filme e cria uma sessão futura pra ele. O filme aparece em `GET /movies` com essa sessão na resposta seguinte, sem espera.
- **AC5**: criar ou editar filme com `title` vazio, `durationMinutes` fora de 1–600 `posterUrl` que não é URL `http`/`https` ou `rating` fora de `L`, `10`, `12`, `14`, `16`, `18` responde 400 e não grava nada. `rating` ausente é aceito.
- **AC6**: editar `durationMinutes` de um filme de forma que alguma sessão futura dele passe a se sobrepor a outra sessão da mesma sala responde 409 e a duração não muda. Edição que não cria sobreposição é aceita.
- **AC7**: excluir filme sem nenhuma sessão responde 204 e o filme some de `GET /movies`. Excluir filme com qualquer sessão (passada ou futura) responde 409 e nada é apagado.
- **AC8**: admin lista, cria e edita cinemas (`name`, `address`, `city` obrigatórios). Campo obrigatório vazio responde 400.
- **AC9**: criar sala com `rows = R` e `seatsPerRow = S` grava a sala e exatamente `R × S` assentos, com fileiras `A` até a R-ésima letra e números de `1` a `S` em cada fileira.
- **AC10**: criar sala com `rows` fora de 1–26, `seatsPerRow` fora de 1–40 ou `cinemaId` inexistente responde 400 (validação) ou 404 (cinema inexistente). Criar ou renomear sala com nome já usado no mesmo cinema responde 409.
- **AC11**: mudar `rows`/`seatsPerRow` de sala sem nenhuma sessão regera os assentos com o novo layout. Mudar layout de sala com qualquer sessão responde 409 e os assentos ficam como estavam. Renomear sala com sessões é permitido.
- **AC12**: criar sessão com filme e sala existentes, `startsAt` futuro e `priceCents > 0` responde 201. `GET /sessions/:id/seats` da nova sessão devolve todos os assentos da sala como livres.
- **AC13**: criar sessão com `startsAt` no passado, `priceCents <= 0` ou sem campo obrigatório responde 400. `movieId` ou `roomId` inexistente responde 404.
- **AC14**: criar ou editar sessão cujo intervalo `[startsAt, startsAt + duração do filme)` se sobrepõe a outra sessão da mesma sala responde 409. Sessão que começa exatamente no fim da outra é aceita. Mesmo horário em sala diferente é aceito.
- **AC15**: duas criações simultâneas de sessões que se sobrepõem na mesma sala resultam em exatamente uma sessão gravada. A outra requisição responde 409.
- **AC16**: editar `movieId`, `roomId`, `startsAt` ou `priceCents` de sessão futura sem booking `confirmed`, sem booking `pending` que ainda trava assentos e sem hold ativo é aceito e reflete em `GET /movies`. Booking `pending` trava assentos enquanto está dentro do `expires_at` ou tem pagamento `pending`/`in_process` (mesma regra de `docs/flows/pending-booking-expiry/spec.md`). Com booking `pending` que ainda trava assentos, com booking `confirmed` ou com hold ativo no Valkey, editar `movieId`, `roomId` ou `startsAt` responde 409 e nada muda. Editar `priceCents` com booking `pending` que ainda trava assentos ou hold ativo responde 409. Booking `pending` vencido sem pagamento em andamento, `expired` ou `cancelled` não bloqueia a edição. Editar `priceCents` com só booking `confirmed` é aceito, e o `booking_seats.price_cents` dos ingressos já vendidos não muda.
- **AC17**: excluir sessão futura sem nenhum booking e sem hold ativo responde 204 e a sessão some de `GET /movies`. Excluir sessão com hold ativo ou com booking em qualquer status (`pending`, `confirmed`, `cancelled`, `expired`) responde 409 e nada é apagado.
- **AC18**: editar ou excluir sessão que já começou (`startsAt <= agora`) responde 409.
- **AC19**: excluir sala sem nenhuma sessão apaga a sala e os assentos dela (204). Excluir sala com qualquer sessão responde 409 e nada é apagado.
- **AC20**: `POST /auth/register` com `role: "admin"` no body cria o usuário com `role: "customer"`.
- **AC21**: no front, `/admin` e sub-rotas sem token de usuário redirecionam pra `/login`. Com token de usuário `role: "customer"` mostram "Acesso restrito" e não chamam nenhuma rota `/admin/*`. Com `role: "admin"` mostram a área admin.
- **AC22**: o link "Admin" no menu de perfil aparece só pra usuário `role: "admin"`.
- **AC23**: no front, admin cadastra filme, sala e sessão pelos formulários, e a sessão criada aparece em `/movies`.
- **AC24**: no front, quando a API responde 400 ou 409 num formulário admin, a mensagem de erro aparece no formulário e os valores digitados continuam preenchidos.
- **AC25**: no formulário de sessão, o horário digitado é interpretado em `America/Sao_Paulo`, independente do fuso do navegador, e enviado como ISO 8601 que corresponde ao instante UTC certo (ex: `2026-12-20T19:00` digitado → `2026-12-20T22:00:00.000Z`). Ao editar, a sessão gravada em UTC aparece no formulário e na lista no horário de `America/Sao_Paulo`.

## Modelo de dados / API (impacto)

- **Schema do banco: sem mudança.** Todas as tabelas e colunas necessárias já existem (`movies.duration_minutes`, `rooms.rows`, `rooms.seats_per_row`, `unique(cinema_id, name)`, `users.role`).
- Novo `AdminModule` (`apps/api/src/admin/`), registrado no `AppModule`. Controllers separados por recurso. Commands e queries separados por service, no mesmo estilo CQRS "light" do resto da API.
- Novo `RolesGuard` + decorator `@Roles(...)` em `apps/api/src/auth/`.
- Rotas (todas com `JwtAuthGuard` + `RolesGuard` + `@Roles("admin")`):

  | Método | Rota | Sucesso | Erros |
  |--------|------|---------|-------|
  | GET | `/admin/movies` | 200 | |
  | GET | `/admin/movies/:id` | 200 | 404 |
  | POST | `/admin/movies` | 201 | 400 |
  | PATCH | `/admin/movies/:id` | 200 | 400, 404, 409 (sobreposição) |
  | DELETE | `/admin/movies/:id` | 204 | 404, 409 (tem sessão) |
  | GET | `/admin/cinemas` | 200 | |
  | GET | `/admin/cinemas/:id` | 200 | 404 |
  | POST | `/admin/cinemas` | 201 | 400 |
  | PATCH | `/admin/cinemas/:id` | 200 | 400, 404 |
  | GET | `/admin/rooms` | 200 | |
  | GET | `/admin/rooms/:id` | 200 | 404 |
  | POST | `/admin/rooms` | 201 | 400, 404 (cinema), 409 (nome) |
  | PATCH | `/admin/rooms/:id` | 200 | 400, 404, 409 (nome, layout com sessão) |
  | DELETE | `/admin/rooms/:id` | 204 | 404, 409 (tem sessão) |
  | GET | `/admin/sessions` | 200 | |
  | GET | `/admin/sessions/:id` | 200 | 404 |
  | POST | `/admin/sessions` | 201 | 400, 404 (filme/sala), 409 (sobreposição) |
  | PATCH | `/admin/sessions/:id` | 200 | 400, 404, 409 (sobreposição, atividade, já iniciada) |
  | DELETE | `/admin/sessions/:id` | 204 | 404, 409 (booking, hold, já iniciada) |

- DTOs com `class-validator`. `PATCH` aceita campos parciais. `ValidationPipe` global já roda com `whitelist: true, transform: true` (`apps/api/src/main.ts`).
- Mensagens de erro em português, mesmo padrão das exceptions existentes (ex: `"Sessão não encontrada"`).
- `sessions.starts_at` continua `timestamptz` (UTC). A API aceita `startsAt` em ISO 8601 com offset e devolve em ISO UTC. A conversão pra `America/Sao_Paulo` é só no front.
- Valkey: só leitura das chaves `seat-hold:<sessionId>:*` pra checar hold ativo. Nenhuma chave nova.
- `GET /movies`, `GET /sessions/:id/seats` e rotas de hold/booking: sem mudança.
- Front: `AdminRoute`, páginas em `apps/web/src/features/admin/`, link condicional no `ProfileMenu`. `AuthUser.role` já existe (`apps/web/src/features/auth/types.ts`).
- `apps/api/README.md`: seção curta "Como criar um admin" com o SQL de promoção.

## Riscos

- **Papel desatualizado no token**: quem é rebaixado mantém acesso admin até o token expirar (até `JWT_EXPIRES_IN`, padrão 1h). Mitigação: TTL curto do token. Consulta ao banco por requisição fica como evolução se virar problema.
- **Sessão com booking `pending` abandonado**: a expiração de `pending` está implementada (`docs/flows/pending-booking-expiry/spec.md`). Passado o `expires_at` sem pagamento em andamento, o booking deixa de bloquear a edição da sessão mesmo antes de o sweeper mudar o status pra `expired` (AC16). Ele continua bloqueando a exclusão, porque é histórico (AC17).
- **Race entre checagem de hold e novo hold**: o admin checa holds e, no mesmo instante, um cliente segura um assento. A janela é de milissegundos. Pra exclusão o risco é baixo, porque o hold expira em 600s e o booking seguinte falha com 404 de sessão. Pra edição de sala/horário, o cliente pode ficar com hold de assento de outra sala até o TTL. Aceito nesta versão.
- **Layout gerado diferente do layout de exemplo**: o `SeatMap` do front tem regras visuais pensadas pra sala do seed (bloco do meio de 20 assentos, corredores a partir de 16 por fileira). Sala retangular gerada pelo admin precisa renderizar corretamente nessas regras. Vale um teste de componente com layout pequeno (ex: 5 × 8) e grande (26 × 40).

## Perguntas em aberto

Nenhuma.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`. Teste de integração/e2e em português, com `// GIVEN`, `// WHEN`, `// THEN`, sem `it.each`. Lógica repetida (login como admin/customer, criar filme/sala/sessão, chamar rota admin) fica em helpers (`apps/api/test/helpers/admin.ts`, por exemplo `createMovieAsAdmin`, `createRoomAsAdmin`, `createSessionAsAdmin`), e o corpo do `it` só orquestra esses helpers. Teste unitário segue o padrão `it("should ...")` com 3A.

| AC | Nível | Teste |
|----|-------|-------|
| AC1 | integração (Jest + Supertest, Postgres/Valkey reais) | um `it` por caso: sem token, token inválido, token expirado → 401 numa rota admin de leitura e numa de escrita |
| AC1, AC2 | unitário | `RolesGuard` permite `role: "admin"`, recusa `customer` com 403, recusa quando não há `request.user` (aqui `it.each` é bem-vindo) |
| AC2 | integração | `it("AC2: deve recusar com 403 usuário cliente tentando criar filme")` e equivalente pra excluir sessão, confirmando que nada mudou no banco |
| AC3 | integração | token de convidado recusado com 401 numa rota admin (entra junto com a identidade de convidado) |
| AC4 | integração | admin cria filme + sessão futura e o `GET /movies` seguinte já traz os dois |
| AC5 | integração | um `it` por campo inválido: título vazio, duração 0, duração 601, `posterUrl` inválida, `rating` inválido (ex: `"15"`) |
| AC5 | unitário | DTO de filme, incluindo `rating` aceito (`L`, `10`, `12`, `14`, `16`, `18`, ausente) e recusado (`"15"`, `"livre"`, `""`) (aqui `it.each` é bem-vindo) |
| AC6 | integração | duração nova que cria sobreposição → 409 e duração mantida; duração nova sem sobreposição → 200 |
| AC7 | integração | filme sem sessão excluído; filme com sessão futura → 409; filme só com sessão passada → 409 |
| AC8 | integração | criar, editar e listar cinema; campo obrigatório vazio → 400 |
| AC9 | integração | sala 3 × 4 gera 12 assentos `A1`..`C4` |
| AC9 | unitário | gerador de layout (`rows`, `seatsPerRow` → lista de `{ rowLabel, seatNumber }`), incluindo 26 fileiras terminando em `Z` |
| AC10 | integração | um `it` por caso: `rows` 0, `rows` 27, `seatsPerRow` 41, cinema inexistente, nome duplicado no mesmo cinema, nome igual em cinema diferente aceito |
| AC11 | integração | layout alterado sem sessão regera assentos; layout alterado com sessão → 409 e assentos iguais; renomear sala com sessão → 200 |
| AC12 | integração | sessão criada e `GET /sessions/:id/seats` devolve todos os assentos livres |
| AC13 | integração | um `it` por caso: `startsAt` passado, `priceCents` 0, filme inexistente, sala inexistente |
| AC14 | integração | um `it` por caso: sobreposição no início, sobreposição no fim, sessão contida em outra, sessão encostada no fim (aceita), mesmo horário em outra sala (aceita), edição de `startsAt` que cria sobreposição |
| AC14 | unitário | função de sobreposição de intervalos (aqui `it.each` é bem-vindo: encostado, contido, parcial, disjunto) |
| AC15 | integração | duas requisições paralelas (`Promise.all`) criando sessões sobrepostas na mesma sala: uma 201, uma 409, uma linha no banco |
| AC16 | integração | um `it` por caso: edição sem atividade aceita e refletida em `GET /movies`; mudar `startsAt` com booking `pending` → 409; mudar `startsAt` com booking `confirmed` → 409; mudar `startsAt` com hold ativo no Valkey → 409; mudar `priceCents` com booking `pending` → 409; mudar `priceCents` com hold ativo → 409 |
| AC16 | integração | `it("AC16: deve permitir mudar o horário de sessão cuja reserva pendente já passou do prazo sem pagamento em andamento")` e `it("AC16: deve permitir mudar o horário de sessão que só tem reserva expirada")` |
| AC16 | integração | `it("AC16: deve permitir mudar o preço de sessão que só tem reservas confirmadas, sem alterar o preço já pago")`: `priceCents` novo gravado e `booking_seats.price_cents` dos ingressos vendidos igual ao anterior |
| AC17 | integração | um `it` por caso: exclusão sem atividade (sessão some do catálogo); com hold ativo; com booking `pending`; com `confirmed`; com `cancelled` → 409 |
| AC17 | integração | `it("AC17: deve recusar com 409 excluir sessão com reserva expirada")` |
| AC18 | integração | editar sessão já iniciada → 409; excluir sessão já iniciada → 409 |
| AC19 | integração | sala sem sessão excluída junto com os assentos; sala com sessão → 409 |
| AC20 | integração | `POST /auth/register` com `role: "admin"` cria `customer` (em `apps/api/test/auth.e2e-spec.ts`) |
| AC21 | componente (Vitest + RTL) | `AdminRoute`: sem token redireciona pra `/login`; `customer` vê "Acesso restrito" e nenhuma chamada admin é feita; `admin` vê o conteúdo |
| AC22 | componente | `ProfileMenu` mostra "Admin" só pra `role: "admin"` |
| AC23 | e2e (Playwright) | admin loga, cria filme, sala e sessão pelos formulários e vê a sessão em `/movies` |
| AC24 | componente | formulário de sessão com resposta 409 da API mostra a mensagem e mantém os campos preenchidos |
| — | componente | `SeatMap` renderiza sala retangular gerada (5 × 8 e 26 × 40) sem quebrar alinhamento |
| AC25 | componente | com o fuso do processo de teste diferente de São Paulo (ex: `TZ=UTC`), formulário de sessão com `2026-12-20T19:00` envia `startsAt` `2026-12-20T22:00:00.000Z`; edição de sessão gravada em UTC mostra o horário de São Paulo |
| AC25 | unitário | conversão `datetime-local` em `America/Sao_Paulo` ↔ ISO UTC (aqui `it.each` é bem-vindo) |
| — | unitário | conversão de preço em reais pra centavos no front |
