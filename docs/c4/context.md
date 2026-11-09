# C4 — Diagrama de Contexto

Visão macro: quem interage com o sistema e com quais sistemas externos.

Diagrama: [`context.drawio`](./context.drawio) — abrir em [app.diagrams.net](https://app.diagrams.net) (File → Open From → Device).

## Resumo

- **Cliente** — navega no catálogo e no mapa de assentos sem login (como convidado) e só faz login ao avançar pro pagamento.
- **Admin** — usuário com `role: "admin"`, cadastra filmes, cinemas, salas e sessões na área `/admin`.
- **Mercado Pago** (externo) — Checkout Transparente: o cartão é tokenizado no browser pelo SDK JS do Mercado Pago e a API cria o pagamento na Payments API; a confirmação de status que muda depois chega por webhook.
- **Servidor de e-mail** (externo) — SMTP pro e-mail de confirmação de compra (Mailpit em dev).
