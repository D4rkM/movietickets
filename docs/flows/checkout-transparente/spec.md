# Spec: Checkout transparente (Card Payment Brick, cartão)

> Milestone: AC3 (Notion, Delivery). Os números de AC desta spec são locais à feature — não confundir com o milestone AC3 do Notion.

## Contexto

Hoje o pagamento usa Checkout Pro: o back cria uma Preference, o front redireciona pro `init_point` do Mercado Pago e volta por `/checkout/retorno`. Isso depende de `back_urls`/`auto_return`, de `WEB_URL` público pra testar o retorno e de sessão preservada no redirect. Esta spec troca o fluxo de cartão pelo Checkout Transparente: o formulário fica dentro da nossa página (Card Payment Brick, `@mercadopago/sdk-react`), o front envia só o `token` tokenizado, e o back cria o pagamento direto na Payments API e recebe o `status` na resposta.

## Escopo

- Pagamento com cartão de crédito (e débito, se o Brick retornar como tal). Pix fica fora desta spec.
- Cartão nunca passa pelo nosso back: o Brick tokeniza no client (escopo PCI SAQ A). O back recebe só token, método, parcelas, emissor e dados do pagador.
- Webhook continua existindo como fonte de verdade assíncrona.

## Fora de escopo

- Pix (QR code).
- Reembolso / estorno.
- Persistir múltiplos pagamentos por booking (hoje `payments` tem upsert por `bookingId`; manter por enquanto).
- Remoção de infraestrutura de ngrok além do necessário pro webhook.

## Critérios de aceitação

- **AC1**: a página de checkout renderiza o Card Payment Brick com o total da reserva calculado pelo back. Nenhum campo de número, validade ou CVV existe no nosso código.
- **AC2**: enviar um token válido em `POST /bookings/:id/payments` cria o pagamento no Mercado Pago e, se `status = approved`, confirma o booking na mesma resposta, sem redirect.
- **AC3**: o valor cobrado é o total calculado no back a partir dos assentos e do tipo de ingresso. Qualquer `amount` enviado pelo front é ignorado.
- **AC4**: a chamada à Payments API envia `X-Idempotency-Key`. Reenviar a mesma tentativa não cria um segundo pagamento.
- **AC5**: `status = rejected` retorna mensagem de erro em pt-BR derivada de `status_detail`, mantém o booking em `pending` e permite nova tentativa com outro cartão enquanto o hold estiver válido.
- **AC6**: `status = in_process` retorna resposta de "aguardando confirmação" e mantém o booking em `pending`. A confirmação final vem pelo webhook.
- **AC7**: o webhook continua re-buscando o pagamento na API e confirma o booking de forma idempotente. Um webhook atrasado de tentativa rejeitada não libera o hold de uma tentativa aprovada.
- **AC8**: o fluxo de Preference deixa de ser usado no cartão: sem `back_urls`, `auto_return` nem `init_point`. A rota `/checkout/retorno` não é mais o destino do cartão.
- **AC9**: booking de outro usuário retorna 404; booking que não está `pending` retorna 409 (mesmo comportamento atual).

## Decisões desta spec (pra revisar)

- **Rejeição não libera o hold.** Hoje o webhook de `rejected`/`cancelled` chama `releaseFailedPaymentBooking`. Com o Brick, o usuário pode tentar outro cartão logo em seguida; liberar o hold numa rejeição tira o assento dele no meio da tentativa. Proposta: `rejected` só mantém `pending`; liberação acontece no timeout do hold (já existente) ou em `cancelled`/cancelamento explícito.
- **Idempotency key por tentativa.** Gerada no back antes de chamar o MP e gravada junto com a tentativa, pra que retry do mesmo POST reuse a mesma chave.
- **Front não envia valor.** O total vem do back; o Brick recebe o `amount` do endpoint de resumo do checkout.

## Modelo de dados (impacto)

- Tabela `payments`: sem mudança de schema nesta spec. Continua com upsert por `bookingId` e guarda `externalPaymentId`, `status`, `amountCents`.
- Configuração: nova variável de front com a public key do Mercado Pago (`VITE_MP_PUBLIC_KEY`). Access token continua só no back.

## Rastreabilidade com testes

Cada AC vira pelo menos um teste com o número da AC no título do `it`, em português, sem `it.each`:

- AC1 → teste de componente (Vitest + RTL) da página de checkout, com o Brick mockado; checa que o total vem da API.
- AC2 → teste de integração do endpoint com Postgres real e cliente do MP mockado no boundary.
- AC3 → teste de integração: body com `amount` adulterado não altera o valor cobrado.
- AC4 → teste unitário do builder de chamada + teste de integração de reenvio da mesma tentativa.
- AC5 / AC6 → testes de integração por `status` retornado pelo MP, incluindo mapeamento de `status_detail`.
- AC7 → teste de integração do webhook: `rejected` atrasado não libera hold de booking aprovado; redelivery é idempotente.
- AC8 → teste de integração: nenhuma chamada a `preferences` no fluxo de cartão.
- AC9 → testes de integração de ownership e status.
