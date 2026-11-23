# Sequence: Painel admin (CRUD de filmes, salas e sessões)

Autorização por papel em `/admin/*` e as regras de escrita que dependem de trava no banco: criação/edição de sessão com checagem de sobreposição (trava `FOR UPDATE` na sala), duração de filme revalidando sessões futuras e layout/exclusão de sala. Spec: [`spec.md`](./spec.md).

Cobre `AdminRoute`/páginas de `/admin` (Frontend) → `Admin*Controller` + `RolesGuard` (Backend) → Postgres (Database) e Valkey (Cache, só leitura de holds).

## 1. Autorização (JwtAuthGuard + RolesGuard)

Todo controller do `AdminModule` usa `@UseGuards(JwtAuthGuard, RolesGuard)` com `@Roles("admin")`. O papel vem do token, sem consulta ao banco por requisição.

```mermaid
sequenceDiagram
    actor Admin
    participant Frontend
    participant Backend
    participant JwtAuthGuard
    participant RolesGuard

    Admin->>Frontend: abre /admin/*
    alt sem token de usuário
        Frontend->>Frontend: AdminRoute redireciona pra /login
    else user.role !== "admin"
        Frontend->>Frontend: AdminRoute mostra "Acesso restrito" (nenhuma chamada /admin/*)
    else role = admin
        Frontend->>Backend: GET/POST/PATCH/DELETE /admin/... (Authorization: Bearer)
        Backend->>JwtAuthGuard: valida token
        alt ausente, inválido, expirado ou de convidado (kind: guest)
            JwtAuthGuard-->>Frontend: 401
        else token de usuário
            JwtAuthGuard->>RolesGuard: request.user = payload
            alt payload.role não está em @Roles
                RolesGuard-->>Frontend: 403 "Acesso restrito a administradores"
            else admin
                RolesGuard->>Backend: segue pro handler
            end
        end
    end
    Note over Frontend,RolesGuard: a checagem do front é só navegação, quem protege é a API. Rebaixado mantém acesso até o token expirar (JWT_EXPIRES_IN)
```

## 2. Criar sessão (sobreposição + FOR UPDATE na sala)

`SessionCommandsService.create`: uma transação trava o filme (`FOR SHARE`, a duração não muda no meio da checagem) e a sala (`FOR UPDATE`) antes de ler as sessões dela. Duas criações concorrentes na mesma sala rodam uma depois da outra, e a segunda enxerga a primeira.

```mermaid
sequenceDiagram
    actor Admin
    participant Frontend
    participant Backend
    participant Database

    Admin->>Frontend: formulário de sessão (horário em America/Sao_Paulo)
    Frontend->>Backend: POST /admin/sessions { movieId, roomId, startsAt (ISO com offset), priceCents }
    Note over Backend: DTO: startsAt futuro, priceCents > 0 (senão 400)
    Backend->>Database: BEGIN
    Backend->>Database: SELECT duration_minutes FROM movies WHERE id FOR SHARE
    alt filme não existe
        Backend->>Database: ROLLBACK
        Backend-->>Frontend: 404 "Filme não encontrado"
    else existe
        Backend->>Database: SELECT id FROM rooms WHERE id FOR UPDATE
        alt sala não existe
            Backend->>Database: ROLLBACK
            Backend-->>Frontend: 404 "Sala não encontrada"
        else sala travada (outra criação na mesma sala espera aqui)
            Backend->>Database: sessões da sala que começam entre (início - 600 min) e o fim do candidato, com duração do filme
            Note over Backend: sobrepõe quando A.start < B.end e B.start < A.end. Encostar (fim = início) não sobrepõe. Sessões passadas contam
            alt há sobreposição
                Backend->>Database: ROLLBACK
                Backend-->>Frontend: 409 "Horário se sobrepõe a outra sessão na mesma sala"
            else livre
                Backend->>Database: INSERT sessions
                Backend->>Database: COMMIT (libera a trava da sala)
                Backend-->>Frontend: 201 sessão (aparece em GET /movies na hora, sem cache)
            end
        end
    end
```

## 3. Editar e excluir sessão (atividade de compra)

`SessionCommandsService.update`/`delete`: trava a sessão (`FOR UPDATE`, o que também segura um `INSERT` de booking concorrente pela FK), confere se já começou, lê a atividade (bookings no Postgres, holds no Valkey) e só então aplica. Ordem de trava sempre sessão → filme → sala, pra duas transações admin não se esperarem em ciclo.

```mermaid
sequenceDiagram
    actor Admin
    participant Frontend
    participant Backend
    participant Database
    participant Cache

    Admin->>Frontend: salva edição / clica "Excluir"
    Frontend->>Backend: PATCH /admin/sessions/:id  ou  DELETE /admin/sessions/:id
    Backend->>Database: BEGIN, SELECT sessions FOR UPDATE
    alt não existe
        Backend-->>Frontend: 404
    else startsAt <= now()
        Backend->>Database: ROLLBACK
        Backend-->>Frontend: 409 "Sessão já iniciada não pode ser alterada/excluída"
    else
        opt PATCH sem mudança real (mesmos valores)
            Backend->>Database: COMMIT
            Backend-->>Frontend: 200 sem alterar nada
        end
        opt PATCH que muda filme, sala ou horário
            Backend->>Database: trava filme (FOR SHARE) e sala de destino (FOR UPDATE), 404 se faltar
        end
        Backend->>Database: bookings da sessão (status + activeBookingCondition: dentro do expires_at ou pagamento pending/in_process)
        Backend->>Cache: SCAN seat-hold:{sessionId}:*
        Note over Backend: atividade = booking pending que ainda trava, booking confirmed, qualquer booking, hold ativo
        alt PATCH: movieId/roomId/startsAt com pending ativo, confirmed ou hold
            Backend->>Database: ROLLBACK
            Backend-->>Frontend: 409 filme, sala e horário não podem mudar
        else PATCH: priceCents com pending ativo ou hold
            Backend->>Database: ROLLBACK
            Backend-->>Frontend: 409 preço não pode mudar agora (só confirmed permite: booking_seats.price_cents guarda o preço pago)
        else DELETE: qualquer booking (inclusive cancelled/expired) ou hold ativo
            Backend->>Database: ROLLBACK
            Backend-->>Frontend: 409 sessão tem reservas/assentos segurados
        else PATCH liberado
            opt mudou horário, sala ou filme
                Backend->>Database: checagem de sobreposição (ignorando a própria sessão)
            end
            alt sobrepõe
                Backend->>Database: ROLLBACK
                Backend-->>Frontend: 409 sobreposição
            else ok
                Backend->>Database: UPDATE sessions, COMMIT
                Backend-->>Frontend: 200 sessão atualizada
            end
        else DELETE liberado
            Backend->>Database: DELETE sessions, COMMIT
            Backend-->>Frontend: 204
        end
    end
    Note over Backend,Database: DELETE ainda traduz violação de FK (booking criado entre a checagem e o delete) em 409
```

## 4. Filme: duração revalida sessões futuras; exclusão

`MovieCommandsService`: mudar `durationMinutes` trava o filme (`FOR UPDATE`) e as salas das sessões futuras dele (em ordem de id, sem deadlock), e revalida cada sessão com a duração nova. Filme com qualquer sessão (passada ou futura) não pode ser excluído.

```mermaid
sequenceDiagram
    actor Admin
    participant Backend
    participant Database

    Admin->>Backend: PATCH /admin/movies/:id { durationMinutes }
    Backend->>Database: BEGIN, SELECT movies FOR UPDATE
    alt não existe
        Backend-->>Admin: 404
    else duração mudou
        Backend->>Database: sessões futuras do filme (por startsAt)
        loop salas distintas, em ordem de id
            Backend->>Database: SELECT rooms FOR UPDATE
        end
        loop cada sessão futura
            Backend->>Database: sobreposição na sala com a duração nova (ignorando a própria)
        end
        alt alguma sobrepõe
            Backend->>Database: ROLLBACK
            Backend-->>Admin: 409 nada muda
        else todas cabem
            Backend->>Database: UPDATE movies, COMMIT
            Backend-->>Admin: 200
        end
    end

    Admin->>Backend: DELETE /admin/movies/:id
    Backend->>Database: BEGIN, SELECT movies FOR UPDATE
    Backend->>Database: existe sessão do filme (passada ou futura)?
    alt tem sessão (ou FK acusa sessão criada no meio)
        Backend->>Database: ROLLBACK
        Backend-->>Admin: 409 "Filme tem sessões cadastradas"
    else sem sessão
        Backend->>Database: DELETE movies, COMMIT
        Backend-->>Admin: 204
    end
```

## 5. Sala: gerar assentos, mudar layout e excluir

`RoomCommandsService`: criar sala insere a sala e `rows × seatsPerRow` assentos (`A1`..) na mesma transação. Mudar layout ou excluir só vale sem nenhuma sessão, porque assento é referenciado por `booking_seats` e por chaves de hold.

```mermaid
sequenceDiagram
    actor Admin
    participant Backend
    participant Database

    Admin->>Backend: POST /admin/rooms { cinemaId, name, rows, seatsPerRow }
    Note over Backend: DTO: rows 1-26, seatsPerRow 1-40 (senão 400)
    Backend->>Database: BEGIN, cinema existe?
    alt cinema inexistente
        Backend-->>Admin: 404
    else
        Backend->>Database: INSERT rooms + INSERT seats (rows × seatsPerRow)
        alt unique(cinema_id, name) violada
            Backend->>Database: ROLLBACK
            Backend-->>Admin: 409 nome duplicado no cinema
        else
            Backend->>Database: COMMIT
            Backend-->>Admin: 201
        end
    end

    Admin->>Backend: PATCH /admin/rooms/:id { name | rows | seatsPerRow }
    Backend->>Database: BEGIN, SELECT rooms FOR UPDATE
    opt rows ou seatsPerRow mudaram
        Backend->>Database: existe sessão na sala (passada ou futura)?
        alt tem sessão
            Backend->>Database: ROLLBACK
            Backend-->>Admin: 409 layout não pode mudar
        else sem sessão
            Backend->>Database: DELETE seats da sala + INSERT novo layout
        end
    end
    Backend->>Database: UPDATE rooms (renomear é sempre permitido, respeitando a unicidade), COMMIT
    Backend-->>Admin: 200

    Admin->>Backend: DELETE /admin/rooms/:id
    Backend->>Database: BEGIN, SELECT rooms FOR UPDATE, existe sessão?
    alt tem sessão
        Backend-->>Admin: 409
    else
        Backend->>Database: DELETE seats + DELETE rooms, COMMIT
        Backend-->>Admin: 204
    end
```

## Referências

- `apps/web/src/lib/AdminRoute.tsx`, `apps/web/src/features/admin/`
- `apps/api/src/auth/roles.guard.ts`, `apps/api/src/auth/roles.decorator.ts`, `apps/api/src/auth/jwt-auth.guard.ts`
- `apps/api/src/admin/sessions/session-commands.service.ts`, `session-activity.service.ts`, `session-edit-policy.ts`, `session-schedule.ts`, `session-overlap.ts`
- `apps/api/src/admin/shared/row-locks.ts` (`lockSession`, `lockMovie`, `lockRoom`)
- `apps/api/src/admin/movies/movie-commands.service.ts`, `apps/api/src/admin/rooms/room-commands.service.ts`, `apps/api/src/admin/rooms/seat-layout.ts`
- `apps/api/src/booking/booking-lock.ts` (`activeBookingCondition`)
