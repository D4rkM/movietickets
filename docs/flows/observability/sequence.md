# Sequence: Observabilidade (request → span/métrica/log → OTLP → LGTM → Grafana)

Caminho da telemetria da API até o Grafana: boot condicional do SDK, o que cada request gera (span, métrica, log correlacionado), a limpeza de dados sensíveis antes do export e a navegação trace → log no Grafana. Spec: [`spec.md`](./spec.md).

Estado da implementação: o que está nos diagramas abaixo (bootstrap, instrumentações, patch do Drizzle, remoção de dados pessoais, redact de logs, flush no shutdown e o container `lgtm`) está **implementado**. Também estão **implementados** (PR #92): as métricas de negócio (`BusinessMetrics`, `movietickets.*`), os spans raiz manuais do sweeper e do listener de expiração de hold, e os dashboards e alertas provisionados em `infra/observability/` (seções 6 e 7). Nada neste documento está mais marcado como planejado.

## 1. Boot (só liga com endpoint OTLP)

`apps/api/src/instrumentation.ts` é carregado por `node --require ./dist/instrumentation.js` **antes** do `main.js` (Dockerfile, `start:dev`, `start:prod`), pra as instrumentações enxergarem `http`, fastify, ioredis e pino antes do Nest requerê-los.

```mermaid
sequenceDiagram
    participant Node as Node (--require)
    participant Inst as instrumentation.ts
    participant Env as shouldStartTelemetry(env)
    participant SDK as otel-sdk.ts (NodeSDK)
    participant Drz as drizzle-tracing.ts
    participant App as main.ts (NestJS + Fastify)

    Node->>Inst: carrega antes da aplicação
    Inst->>Inst: dotenv lê apps/api/.env (sem sobrescrever o ambiente real)
    Inst->>Env: OTEL_SDK_DISABLED / OTEL_EXPORTER_OTLP_*ENDPOINT
    alt OTEL_SDK_DISABLED=true ou nenhum endpoint preenchido
        Env-->>Inst: false
        Note over Inst: nada do SDK é carregado (testes, CI, make up-full). @opentelemetry/api devolve tracer/meter no-op
    else endpoint configurado
        Env-->>Inst: true
        Inst->>Inst: applyTelemetryEnvDefaults (service.name=movietickets-api, sampler parentbased_traceidratio 1.0, métricas a cada 15 s)
        Inst->>SDK: require lazy + startOtelSdk()
        SDK->>SDK: instrumentações: http, @fastify/otel, nestjs-core, undici, ioredis, socket.io, pino, runtime-node
        SDK->>SDK: span processors: SensitiveDataSpanProcessor, depois BatchSpanProcessor (OTLP http/protobuf)
        Inst->>Drz: instrumentDrizzle({ databaseUrl }) (patch idempotente)
        Inst->>Inst: shutdownOnSignal(sdk.shutdown) em SIGTERM/SIGINT (limite de 5 s)
    end
    Node->>App: carrega main.js (Nest sobe já instrumentado)
```

## 2. Uma request: span, métrica e log até o Grafana

```mermaid
sequenceDiagram
    actor Cliente
    participant API as API (NestJS + Fastify)
    participant OTel as SDK OpenTelemetry
    participant PG as Postgres
    participant VK as Valkey
    participant MP as Mercado Pago
    participant LGTM as LGTM Collector 4318
    participant Store as Tempo / Prometheus / Loki
    participant Grafana as Grafana 3001

    Cliente->>API: GET /sessions/:id/seats (ou qualquer rota)
    API->>OTel: span SERVER (instrumentation-http) com http.route via @fastify/otel
    API->>OTel: spans do Nest (controller/handler/guards)
    API->>PG: query Drizzle
    API->>OTel: span CLIENT "SELECT bookings" + histograma db.client.operation.duration (SQL parametrizado, nunca os valores)
    API->>VK: comando ioredis
    API->>OTel: span do comando (só o nome, sem chave nem valor)
    opt pagamento / webhook
        API->>MP: fetch (undici)
        API->>OTel: span CLIENT + http.client.request.duration (sem headers, o Bearer do MP não sai)
    end
    API->>OTel: log do pino com trace_id/span_id (instrumentation-pino), já com redact aplicado
    API-->>Cliente: resposta
    API->>OTel: fecha o span SERVER + http.server.request.duration (RED)

    Note over OTel: SensitiveDataSpanProcessor.onEnding: remove client.address, network.peer.address, user_agent.original e troca "params: ..." de erros do Drizzle por [Redacted]
    OTel->>LGTM: OTLP/HTTP protobuf: traces (lote), métricas (a cada 15 s), logs
    LGTM->>Store: traces → Tempo (+ span metrics → Prometheus), métricas → Prometheus, logs → Loki
```

Também alimentam o mesmo caminho, sem request: `instrumentation-runtime-node` (event loop, heap, GC), `instrumentation-socket.io` (eventos do `/seating`) e o log `warn`/`error` do sweeper e do webhook. As métricas `movietickets.*` (`BusinessMetrics`, emitidas depois do commit) e os spans raiz manuais `pending-booking-sweeper.run` e `seat-hold.expired` seguem o mesmo caminho e estão na seção 6.

## 3. Privacidade antes de sair do processo

```mermaid
flowchart LR
    R["request / erro / log"] --> P1["pino redact (LOG_REDACT_PATHS)<br/>authorization, cookie, set-cookie,<br/>body.password, guestToken, token, payer"]
    R --> P4["log: serializer omitClientIdentity<br/>sem remoteAddress/remotePort,<br/>user-agent, x-forwarded-for, x-real-ip"]
    R --> P2["span: SensitiveDataSpanProcessor<br/>sem IP e user agent, params SQL redigidos"]
    R --> P3["instrumentações sem captura de headers,<br/>ioredis só com nome do comando,<br/>Drizzle só com SQL parametrizado"]
    P1 --> E["export OTLP"]
    P2 --> E
    P3 --> E
    P4 --> E
    E --> L["LGTM (dev/demo)"]
```

O `redact` do pino roda na serialização do registro, então o log que a instrumentação envia ao Loki também já sai sem esses campos. IP e user agent do cliente não são mascarados nos logs, são **removidos** do `req` serializado por `omitClientIdentity` (`log-redaction.ts`, ligado em `serializers: { req }` no `LoggerModule`), então não aparecem nem no stdout nem no Loki.

## 4. Do trace ao log no Grafana

```mermaid
sequenceDiagram
    actor Dev as Dev / QA
    participant Grafana as Grafana (Explore)
    participant Tempo
    participant Prom as Prometheus
    participant Loki

    Dev->>Grafana: abre http://localhost:3001 (admin/admin)
    Dev->>Grafana: Explore → Prometheus: http_server_request_duration_seconds_bucket (latência por rota)
    Grafana->>Prom: PromQL
    Dev->>Grafana: Explore → Tempo: busca trace da request lenta/com erro
    Grafana->>Tempo: trace (spans HTTP, Nest, Postgres, Valkey, Mercado Pago)
    Dev->>Grafana: "Logs for this span"
    Grafana->>Loki: {service_name="movietickets-api"} filtrado por trace_id
    Loki-->>Grafana: logs da mesma request (log → trace pelo campo trace_id)
    Dev->>Grafana: Dashboards → pasta MovieTickets (APM, Runtime, Dependências, Negócio), provisionados de infra/observability/
```

## 5. Topologia (docker compose)

```mermaid
flowchart LR
    subgraph host["Host / docker compose"]
        api["API (perfil full ou pnpm dev:api)"] -->|"OTLP/HTTP :4318"| col
        subgraph lgtm["lgtm (perfil observability, grafana/otel-lgtm)"]
            col["OTel Collector"] --> tempo["Tempo"]
            col --> prom["Prometheus"]
            col --> loki["Loki"]
            tempo --> graf["Grafana :3001"]
            prom --> graf
            loki --> graf
        end
        graf -. "alerta por SMTP" .-> mailpit["Mailpit :1025"]
    end
```

No host, a API exporta pra `http://localhost:4318`; no container (`make up-full-obs`), pra `http://lgtm:4318` (`API_OTEL_EXPORTER_OTLP_ENDPOINT`). Sem o perfil `observability`, a variável fica vazia e o SDK não carrega.

## 6. Métricas de negócio e spans manuais

`TelemetryModule` (`@Global`) expõe `BusinessMetrics` (`apps/api/src/telemetry/business-metrics.ts`). O token `METER_PROVIDER` é resolvido por factory (`metrics.getMeterProvider()`) quando o Nest instancia o provider, depois do `instrumentation.ts` ter registrado o SDK. Cada método valida os atributos contra uma allowlist fechada (fora dela vira `other`) e nunca recebe id, e-mail ou texto livre. Os serviços chamam depois do commit; com a telemetria desligada o meter é no-op.

```mermaid
sequenceDiagram
    participant Svc as Seating / Booking / Payment / Refund / Gateway
    participant Sweep as PendingBookingSweeper
    participant Lis as HoldExpiryListener
    participant BM as BusinessMetrics (TelemetryModule)
    participant Span as withRootSpan (spans.ts)
    participant OTel as SDK OpenTelemetry (meter + tracer)
    participant LGTM as LGTM Collector 4318
    participant Prom as Prometheus
    participant Tempo

    Svc->>Svc: operação commitada (hold, reserva, pagamento, estorno, conexão WebSocket)
    Svc->>BM: seatHoldCreated/Rejected/Released, bookingCreated/Confirmed/Expired/Cancelled, paymentStatusChanged, refundRequested/StatusChanged, wsConnectionOpened/Closed, seatBroadcast
    BM->>BM: allowlisted(valor) mantém a cardinalidade baixa
    BM->>OTel: counters, histogramas (booking.seats, sweeper.duration) e UpDownCounter (seating.ws.connections)

    Sweep->>Span: withRootSpan("pending-booking-sweeper.run")
    Span->>OTel: span raiz INTERNAL (sweeper.outcome, sweeper.expired_count)
    Note over Span,OTel: spans do Drizzle e do Valkey do tick viram filhos deste span
    Sweep->>BM: sweeperRun(outcome, duração), bookingExpired("sweeper"), paymentStaleAlert
    Lis->>Span: withRootSpan("seat-hold.expired")
    Span->>OTel: span raiz INTERNAL (session.id, seat.id)
    Lis->>BM: seatHoldReleased("expired")

    OTel->>LGTM: OTLP/HTTP: métricas movietickets.* (a cada 15 s) e traces
    LGTM->>Prom: métricas (nomes com ponto viram sublinhado)
    LGTM->>Tempo: spans raiz e filhos
```

Instrumentos criados no construtor do `BusinessMetrics` (nunca em escopo de módulo, porque a API de métricas não tem proxy). Famílias: `seat_hold.*` (created, rejected, released, transferred), `booking.*` (created, seats, confirmed, expired, cancelled, refund_review_flagged), `payment.*` (attempt.created, status_changed, provider.errors, stale_alert), `sweeper.*` (runs, duration), `seating.ws.*` e `seating.broadcasts`, `notification.email` e `refund.*` (requested, status_changed). `PaymentService` também grava `payment.status` e `payment.status_detail` no span da request via `setActiveSpanAttributes`.

## 7. Dashboards e alertas provisionados

```mermaid
flowchart LR
    prom["Prometheus<br/>(métricas movietickets.*, HTTP, runtime, span metrics)"] --> dash
    tempo["Tempo<br/>(traces e span metrics)"] --> dash
    subgraph graf["Grafana :3001 (provisionado por arquivos, :ro)"]
        dash["Dashboards pasta MovieTickets<br/>apm, runtime, dependencies, business"]
        rules["5 regras de alerta (1 min)<br/>5xx alta, p95 alta, pagamento recusado,<br/>pagamento parado, sweeper parado"]
        policy["notification policy"]
        cp["contact point mailpit-email"]
        rules --> policy --> cp
    end
    prom --> rules
    cp -->|"SMTP :1025"| mailpit["Mailpit<br/>oncall@movietickets.local"]
```

Arquivos: `infra/observability/grafana/dashboards/{apm,runtime,dependencies,business}.json` (uids `movietickets-apm|runtime|dependencies|business`, home do Grafana = APM), `provisioning/dashboards/movietickets.yaml` e `provisioning/alerting/{rules,notification-policies,contact-points}.yaml`. O `lgtm` monta esses caminhos como somente leitura. As regras: `mt-http-5xx-rate`, `mt-http-p95-latency`, `mt-payment-rejection-spike`, `mt-payment-stale` e `mt-sweeper-stopped` (esta alerta também sem dados).

## Referências

- `apps/api/src/instrumentation.ts`, `apps/api/src/telemetry/should-start-telemetry.ts`, `otel-sdk.ts`, `drizzle-tracing.ts`, `sensitive-data-span-processor.ts`, `log-redaction.ts`, `shutdown-on-signal.ts`
- `apps/api/src/telemetry/business-metrics.ts`, `spans.ts`, `telemetry.module.ts`; `infra/observability/grafana/**`
- `apps/api/src/app.module.ts` (`LoggerModule` com `redact: LOG_REDACT_PATHS`)
- `docker-compose.yml` (serviço `lgtm`), `Makefile` (`obs-up`, `obs-down`, `up-full-obs`), `README.md` (seção "Observabilidade")
- `apps/api/test/observability-smoke.e2e-spec.ts` (coletor OTLP falso)
