# Spec: Catálogo público + login antes do pagamento

> Milestone: AC3 (Notion, Delivery). Os números de AC desta spec são locais à feature — não confundir com o milestone AC3 do Notion.

## Contexto

Hoje o site exige login pra ver qualquer coisa: `/movies`, mapa de assentos e checkout ficam atrás do `ProtectedRoute`. A página de catálogo passa a ser a apresentação do site: visitante deslogado navega pelos filmes, sessões e mapa de assentos antes de decidir comprar. O login só é exigido quando a pessoa avança pro pagamento.

Premissa: "escolher o banco" no pedido original é "escolher o assento". Confirmar se for outra coisa.

## Escopo

- Catálogo (`/movies`) e página de sessão/assentos (`/sessions/:id/seats`) acessíveis sem login, em modo leitura.
- Visitante seleciona assentos na UI sem criar hold no servidor.
- Login exigido ao clicar em "Continuar" (antes do checkout), com retorno pra mesma sessão e seleção preservada.
- Usuário logado mantém o fluxo atual (hold ao clicar no assento).

## Fora de escopo

- Cadastro com redes sociais.
- Carrinho persistido no servidor pra visitante.
- Mudança de regra de hold pra usuário logado.
- Pix.

## Decisões desta spec (pra revisar)

- **Visitante não cria hold.** Hold é por usuário (`SETNX` com TTL ligado ao user). Pra visitante, a seleção fica só no front. Consequência: entre selecionar e logar, um assento pode ser pego por outro usuário. Tratado em AC6.
- **Seleção preservada pelo front**, via `sessionStorage` ou query param de seleção. Sem persistência no servidor.
- **Retorno pós-login** aceita só caminho interno (`/sessions/:id/seats...`). Qualquer outro valor de `returnTo` é descartado, pra não virar open redirect.
- **Usuário logado não muda.** Clicar no assento continua criando hold e disparando broadcast.

## Critérios de aceitação

- **AC1**: visitante sem login acessa `/movies` e vê filmes com sessões futuras, sem redirecionamento pra login.
- **AC2**: `GET /sessions/:id/seats` responde 200 sem token, com o mapa (livre / ocupado / segurado). Sem token, `held_by_me` é sempre `false`.
- **AC3**: visitante sem login seleciona e desseleciona assentos livres na UI. Nenhum hold é criado no servidor nesse fluxo.
- **AC4**: visitante clica em "Continuar" → vai pra `/login` com retorno pra mesma sessão. A seleção feita antes do login é restaurada ao voltar.
- **AC5**: após login, o usuário volta pra página de assentos com a seleção restaurada, clica em "Continuar" de novo, cria os holds e avança pro checkout.
- **AC6**: se algum assento selecionado foi ocupado ou segurado por outro usuário antes do login, o front avisa, remove o assento da seleção e não avança.
- **AC7**: `/checkout` e `/tickets` continuam exigindo login. Acesso direto sem token redireciona pra `/login`.
- **AC8**: usuário logado clicando em assento continua criando hold e recebendo broadcast (sem regressão da feature de seleção/hold já entregue).
- **AC9**: `returnTo` aceita apenas caminho interno. Valor externo (ex: `https://...`, `//...`) é ignorado e o usuário vai pra página padrão.

## Modelo de dados / API (impacto)

- `GET /sessions/:id/seats`: passa a aceitar requisição sem token (guard opcional). Com token válido, mantém `held_by_me`. Sem token, `held_by_me = false`.
- Demais endpoints de assento (`POST` / `DELETE` hold) continuam protegidos por `JwtAuthGuard`.
- `GET /movies` já é público. Sem mudança.
- Nenhuma mudança de schema.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`, em português, sem `it.each`:

- AC1 → teste de componente do catálogo sem token + teste e2e (Playwright) navegando como visitante.
- AC2 → teste de integração do endpoint sem token (Postgres real) e com token (`held_by_me` presente).
- AC3 → teste de componente do mapa: clique em assento sem token não chama a API de hold.
- AC4 / AC5 → teste e2e (Playwright): visitante seleciona, clica em continuar, loga, volta com seleção restaurada e avança.
- AC6 → teste de integração: assento tomado durante o login é removido da seleção com aviso.
- AC7 → teste de componente de rota protegida sem token.
- AC8 → teste de integração: hold de usuário logado continua sendo criado e emitido por broadcast.
- AC9 → teste unitário do validador de `returnTo` com valores internos e externos.
