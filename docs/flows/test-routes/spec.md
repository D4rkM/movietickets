# Spec: rotas de teste (`ENABLE_TEST_ROUTES`)

## Contexto

`POST /bookings/:id/confirm` confirma uma reserva `pending` sem pagamento (confirmação mockada). Com só o JWT de usuário, qualquer cliente logado confirmaria a própria reserva sem pagar. A rota existe só pra teste (e2e do front, testes de integração, teste manual) e por isso fica atrás da variável de ambiente `ENABLE_TEST_ROUTES`.

## Critérios de aceitação

- **AC1**: Sem `ENABLE_TEST_ROUTES=true` (variável ausente ou com qualquer outro valor), `POST /bookings/:id/confirm` responde 404, como se a rota não existisse, mesmo com token de usuário válido, e a reserva continua `pending`.
- **AC2**: Com `ENABLE_TEST_ROUTES=true`, a rota confirma a reserva `pending` do usuário autenticado (comportamento anterior).
- **AC3**: Com `ENABLE_TEST_ROUTES=true`, token de convidado continua recusado com 401.

## Fora de escopo

- Outras rotas de teste (hoje só esta existe); novas rotas desse tipo devem usar o mesmo `TestRoutesGuard`.
- Habilitar a flag em Dockerfile ou docker-compose de uso normal: nunca. Ela fica ligada só no Jest de integração (`test/helpers/enable-test-routes.ts`), no CI (`api-ci`, e2e do `web-ci`) e quando o dev sobe a API à mão pra rodar o e2e do front ou a collection do Bruno.

## Rastreabilidade com testes

- AC1, AC2: `apps/api/test/test-routes.e2e-spec.ts`.
- AC3: `apps/api/test/guest-access.e2e-spec.ts` (AC2 do login gate, roda com a flag ligada pelo setup do Jest).
- Unitário: `apps/api/src/booking/test-routes.guard.spec.ts`.
