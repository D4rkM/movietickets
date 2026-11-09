# Roteiro de testes manuais (QA)

Checklist pra validar o produto de ponta a ponta pelo navegador, do catálogo ao pagamento e ao painel admin. Serve pra QA, PO ou dev.

## 1. Objetivo e quando usar

Confirmar que os fluxos de usuário funcionam juntos no ambiente real (front + API + Postgres + Valkey + Mercado Pago sandbox), coisa que os testes automatizados cobrem só em partes.

Rodar o roteiro inteiro:

- antes de fechar um milestone ou release;
- depois de mudança em fluxo de pagamento, reserva/expiração, hold de assento ou login;
- depois de atualizar SDK/credenciais do Mercado Pago ou a configuração de ambiente.

Pra mudança pequena e localizada, basta a seção afetada.

## 2. Pré-requisitos

**Ambiente**

- Ambiente rodando: README, seção [Subir o ambiente local](../../README.md#subir-o-ambiente-local). Front em `http://localhost:5173`, API em `http://localhost:3000`, Mailpit (e-mails) em `http://localhost:8025`.
- Migrations aplicadas e seed rodado. No `make up-full` a API faz isso sozinha no boot; rodando por partes, `make migrate` + `make seed`.
- Credenciais de teste do Mercado Pago: README, seção [Configurar Mercado Pago (sandbox)](../../README.md#configurar-mercado-pago-sandbox).
- Só pra seção 3.7 (webhook): túneis ngrok, README, seção [Rodando com ngrok (webhook do Mercado Pago)](../../README.md#rodando-com-ngrok-webhook-do-mercado-pago).

**Dois usuários ao mesmo tempo**

O login fica no `localStorage`, que é compartilhado entre abas do mesmo navegador. Pra ter dois usuários (ou convidado + usuário) lado a lado, usar uma janela normal e uma **janela anônima** (ou dois navegadores/perfis). Onde o roteiro diz "outra aba", é nesse sentido.

**Usuários de teste (seed)**

| E-mail | Papel |
|---|---|
| `cliente@movietickets.dev` | cliente |
| `cliente2@movietickets.dev` | cliente (segundo usuário) |
| `admin@movietickets.dev` | admin |

Senha: constante `DEV_PASSWORD` em `apps/api/src/db/seed.ts` (o seed também imprime no terminal).

**Cartão de teste do Mercado Pago** (público, da página [Cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards))

| Campo | Valor |
|---|---|
| Número | Mastercard `5031 4332 1540 6351` |
| CVV | `123` |
| Validade | `11/30` |
| CPF | `12345678909` |
| Nome do titular | `APRO` → aprovado · `OTHE` → recusado |

## 3. Roteiro

Formato: `- [ ] ação → resultado esperado`. Marcar cada item ao validar.

### 3.1 Catálogo e login com convidado

Spec: `docs/flows/public-catalog-login-gate/spec.md` (AC1, AC3, AC5, AC6, AC7, AC8, AC13, AC15)

Começar deslogado (janela anônima nova).

- [ ] Abrir `/movies` sem login → lista de filmes com sessões futuras, sem redirecionar pro login.
- [ ] Abrir `/tickets` ou `/checkout` direto, sem login → redireciona pra `/login`.
- [ ] Clicar numa sessão e em 2 assentos livres → os 2 ficam marcados como seus; botão mostra "Continuar (2 assentos)".
- [ ] Recarregar a página → os mesmos 2 assentos continuam selecionados.
- [ ] Clicar em "Continuar (2 assentos)" → vai pra `/login`.
- [ ] Logar com `cliente@movietickets.dev` → volta pro mapa da mesma sessão com os 2 assentos como seus.
- [ ] (Opcional, limite) Em outra janela, `cliente@` logado segura 2 assentos na mesma sessão. Na janela anônima, convidado segura 6 outros e loga como `cliente@` → aviso "Alguns assentos não ficaram com você:" listando os 2 mais antigos com "liberado para respeitar o limite de 6 assentos por sessão"; ficam 6 selecionados.
- [ ] (Opcional, hold expirado) Como convidado, segurar assentos e esperar mais de 10 min antes de logar → após o login, aviso listando esses assentos com "o tempo de reserva acabou antes do login", e eles saem da seleção.

### 3.2 Tempo real em duas abas

Spec: `docs/flows/public-catalog-login-gate/spec.md` (AC12). Fluxo base sem spec própria (anterior ao SDD): `docs/flows/booking/sequence.md`.

Janela A com `cliente@`, janela B com `cliente2@`, as duas no mapa da mesma sessão.

- [ ] Em A, segurar um assento → em B ele aparece ocupado na hora, sem recarregar.
- [ ] Em B, tentar clicar nesse assento → não fica com B.
- [ ] Em A, soltar o assento (clicar de novo) → em B ele volta a livre na hora.

### 3.3 Checkout transparente

Spec: `docs/flows/checkout-transparente/spec.md` (AC2, AC3, AC4, AC6, AC7, AC9, AC18)

Logado como `cliente@`, com 1 ou 2 assentos seguros.

- [ ] Clicar em "Continuar (N assentos)" e depois em "Continuar para pagamento" → reserva criada, aparece o formulário de pagamento.
- [ ] Digitar número, validade e CVV → campos aceitam digitação; aparece "Bandeira: ..." e o select de "Parcelas" é carregado.
- [ ] Clicar em "Pagar" com nome vazio ou CPF inválido → mensagem em pt-BR no campo ("CPF inválido." etc.), sem enviar pagamento.
- [ ] Recarregar a página antes de pagar → retoma a mesma reserva na etapa de pagamento (não pede pra reservar de novo nem dá conflito).
- [ ] Pagar com titular `OTHE` → "Pagamento recusado. Confira os dados ou use outro cartão."; continua no checkout.
- [ ] Na mesma reserva, pagar com titular `APRO` → tela "Pagamento aprovado!" com "Ver meus ingressos".
- [ ] Abrir o Mailpit → chegou o e-mail de confirmação da compra.
- [ ] Em outra janela no mapa da sessão → os assentos pagos aparecem ocupados.

### 3.4 Ingressos e cancelamento

Sem spec própria (fluxo anterior ao SDD). Ver `docs/flows/booking/sequence.md`.

- [ ] Menu de perfil → "Ver ingressos" → página "Meus ingressos" mostra o ingresso pago na 3.3 (filme, horário, cinema, sala, assentos, total).
- [ ] Clicar em "Cancelar" → confirmação "Deseja mesmo cancelar o ingresso de ...?" → "Sim, cancelar" → ingresso some da lista.
- [ ] Abrir o mapa da sessão → os assentos desse ingresso estão livres de novo.

### 3.5 Expiração de reserva

Spec: `docs/flows/pending-booking-expiry/spec.md` (AC2, AC3, AC8, AC16, AC17) e `docs/flows/checkout-transparente/spec.md` (AC21)

Janela A com `cliente@`, janela B com `cliente2@` no mapa da mesma sessão.

- [ ] Em A, segurar um assento, clicar em "Continuar para pagamento" e parar no formulário → em B o assento aparece ocupado.
- [ ] Esperar ~10–11 min (prazo de 10 min + até 1 min do job de expiração) sem pagar → em B o assento volta a livre sozinho, sem recarregar.
- [ ] Em A, tentar pagar essa reserva vencida → "Sua reserva expirou. Escolha os assentos novamente." com o botão "Escolher assentos".
- [ ] Clicar em "Escolher assentos" → volta pro mapa da sessão.

### 3.6 Painel admin

Spec: `docs/flows/admin-panel/spec.md` (AC7, AC9, AC12, AC14, AC21, AC22, AC23, AC24, AC25)

- [ ] Logado como `cliente@`, abrir `/admin` → "Acesso restrito"; o menu de perfil não tem o link "Admin".
- [ ] Logado como `admin@` → o menu de perfil tem o link "Admin", que abre o painel.
- [ ] Filmes → "Novo filme" → preencher e "Salvar" → filme aparece na lista.
- [ ] Salas → "Nova sala" (cinema do seed, 5 fileiras, 8 assentos por fileira) → "Salvar" → sala aparece na lista.
- [ ] Sessões → "Nova sessão" com o filme e a sala novos, início futuro (horário de São Paulo) e preço → "Salvar" → sessão aparece na lista com o mesmo horário digitado.
- [ ] Abrir `/movies` → o filme novo aparece com essa sessão.
- [ ] Criar outra sessão na mesma sala com horário que se sobrepõe à anterior → erro no formulário; os valores digitados continuam preenchidos.
- [ ] Abrir o mapa da sessão nova → layout A1–E8 (5 fileiras × 8), todos livres.
- [ ] Filmes → "Excluir" no filme que tem sessão → confirmar → erro na página; o filme continua na lista.

### 3.7 Webhook (opcional)

Spec: `docs/flows/checkout-transparente/spec.md` (AC9, AC25)

Precisa dos túneis ngrok, com `PUBLIC_API_URL` apontando pro túnel da API (ver pré-requisitos).

- [ ] Abrir o front pela URL do túnel web e fazer uma compra **nova** com titular `APRO` → "Pagamento aprovado!".
- [ ] `docker compose logs api` (ou o terminal do `pnpm dev:api`) → aparece `POST /payments/webhook` com status 200, e a reserva não é confirmada duas vezes (um e-mail só no Mailpit).

## 4. Como reportar um problema

Abrir o relato com:

- **Passo**: seção e item do roteiro (ex: 3.3, "pagar com titular `OTHE`").
- **O que apareceu na tela**: texto exato ou print.
- **Console do navegador**: erros da aba Console do DevTools.
- **Rede**: request e response da chamada que falhou (aba Network: URL, método, status, corpo da resposta).
- **Horário** em que aconteceu, pra cruzar com os logs da API (`docker compose logs api`).

Nunca colar no relato token de acesso, Access Token/Public Key do Mercado Pago ou URL de túnel.

## 5. Manter este roteiro

Toda feature nova com fluxo de usuário adiciona sua seção aqui, junto com a spec, apontando pras ACs que ela cobre.
