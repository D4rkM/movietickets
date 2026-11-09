# C4 — Diagrama de Container

Detalha as peças dentro do sistema Cinema Tickets.

Diagrama: [`container.drawio`](./container.drawio) — abrir em [app.diagrams.net](https://app.diagrams.net) (File → Open From → Device).

Diagramas de Component (por módulo da API) e os diagramas de sequência/classe por feature ficam em `docs/flows/<feature>/`, criados conforme cada feature é desenvolvida.

## Containers e relações

| Container | Papel |
|---|---|
| Web App (React + Vite) | SPA: catálogo, mapa de assentos em tempo real, login, checkout, "Meus ingressos", área `/admin`. Carrega o SDK JS do Mercado Pago (`@mercadopago/sdk-js`) pra montar os campos seguros de cartão e gerar o token — dados de cartão vão direto do browser pro Mercado Pago, nunca pela API |
| API (NestJS + Fastify) | REST + WebSocket Gateway (`/seating`). Módulos Catalog, Seating, Booking, Payment, Auth, Admin, Notification. Roda também o job periódico `PendingBookingSweeper` (`@nestjs/schedule`, a cada 60s) que expira reservas pendentes vencidas |
| PostgreSQL | Fonte de verdade: catálogo, `bookings`/`booking_seats` (unique `session_id + seat_id`), `payments` (uma linha por tentativa) e `payment_events` (append-only). Ver `docs/schema.md` |
| Valkey | Seat hold com TTL (`seat-hold:*`), índice de holds de convidado e keyspace notifications pra avisar hold expirado. Sem cache de catálogo |
| Mercado Pago (externo) | Payments API (criação do pagamento com `X-Idempotency-Key`, consulta no webhook) + SDK JS no browser |
| Servidor de e-mail (externo) | SMTP do e-mail de confirmação (Mailpit em dev) |
