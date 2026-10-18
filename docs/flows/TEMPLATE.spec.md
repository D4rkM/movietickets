# Spec: <nome da feature>

> Copiar essa pasta/arquivo pra `docs/flows/<feature>/spec.md` ao começar uma feature nova. Escrever a spec ANTES do código — ver `CLAUDE.md` ("Regra permanente: spec-driven development").

## Contexto

<1-2 frases: o que essa feature resolve, por que ela existe agora.>

## Critérios de aceitação

- **AC1**: <critério, frase declarativa e testável>
- **AC2**: <critério>
- **AC3**: <critério>

## Fora de escopo

<o que essa feature explicitamente NÃO cobre, pra não virar escopo implícito depois.>

## Rastreabilidade com testes

Cada AC vira pelo menos um teste de integração/e2e (`apps/api/test/*.e2e-spec.ts` ou `apps/web/.../*.e2e.ts`) com o número da AC no título do `it`, ex:

```ts
it("AC2: deve bloquear o segundo usuário de segurar um assento já ocupado", async () => { ... });
```

Sem vínculo com card de board (Notion/Jira/etc.) por nome ou ID — a spec é a fonte única, o card só aponta pra ela.
