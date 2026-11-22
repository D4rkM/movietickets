import { randomUUID } from "node:crypto";
import { ApiProcess } from "./helpers/api-process";
import {
  attemptLoginWithSecrets,
  createSmokeCinema,
  fastExportEnv,
  getSeatMap,
  holdSeat,
  isDescendantOf,
  issueGuestToken,
  listMovies,
  releaseAllHolds,
  slowExportEnv,
  SmokeDatabase,
  spansOfTrace,
  startApiWithoutTelemetry,
  startApiWithTelemetry,
  waitForLogOfTrace,
  waitForServerSpan,
} from "./helpers/observability-smoke";
import { FakeOtlpCollector, OTLP_SPAN_KIND, startFakeOtlpCollector, waitFor } from "./helpers/otlp-collector";

/**
 * Smoke test of the OpenTelemetry bootstrap (docs/flows/observability/spec.md).
 * Runs the compiled API as a child process (`node --require
 * dist/instrumentation.js dist/main.js`) pointed at a fake OTLP collector,
 * because the auto-instrumentations don't hook reliably inside Jest (U3).
 * Requires `pnpm --filter api build` first.
 */
jest.setTimeout(60_000);

describe("Observabilidade: API compilada com OpenTelemetry (smoke)", () => {
  let cinema: SmokeDatabase;

  beforeAll(async () => {
    cinema = await createSmokeCinema("Observability Smoke");
  });

  afterAll(async () => {
    await cinema.close();
  });

  describe("sem endpoint OTLP configurado", () => {
    let collector: FakeOtlpCollector;
    let api: ApiProcess;

    beforeAll(async () => {
      collector = await startFakeOtlpCollector();
      api = await startApiWithoutTelemetry();
    });

    afterAll(async () => {
      await api.stop();
      await collector.close();
    });

    it("AC1: não deve exportar nada quando o endpoint OTLP não está configurado", async () => {
      // GIVEN a API sem nenhuma variável OTEL_* de endpoint e um coletor escutando

      // WHEN ela atende requests normalmente
      const movies = await listMovies(api);
      const token = await issueGuestToken(api);
      const seatMap = await getSeatMap(api, token, cinema.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // THEN as respostas são as de sempre e nada chega no coletor
      expect(movies.status).toBe(200);
      expect(seatMap.status).toBe(200);
      expect(collector.requestCount()).toBe(0);
    });
  });

  describe("com endpoint OTLP configurado", () => {
    let collector: FakeOtlpCollector;
    let api: ApiProcess;
    let guestToken: string;

    beforeAll(async () => {
      collector = await startFakeOtlpCollector();
      api = await startApiWithTelemetry(fastExportEnv(collector));
      guestToken = await issueGuestToken(api);
    });

    afterAll(async () => {
      await releaseAllHolds(api, guestToken, cinema.sessionId);
      await api.stop();
      await collector.close();
    });

    it("AC2: deve gerar span de request com a rota em formato de template", async () => {
      // GIVEN a API exportando telemetria

      // WHEN o mapa de assentos de uma sessão é consultado
      const response = await getSeatMap(api, guestToken, cinema.sessionId);

      // THEN o span SERVER e a métrica de duração usam a rota template, sem o id real
      expect(response.status).toBe(200);
      const span = await waitForServerSpan(collector, "GET", "/sessions/:id/seats");
      expect(span.name).toBe("GET /sessions/:id/seats");
      expect(span.attributes["http.response.status_code"]).toBe(200);
      const point = await waitFor("http.server.request.duration da rota", () =>
        collector
          .dataPoints("http.server.request.duration")
          .find((p) => p.attributes["http.route"] === "/sessions/:id/seats"),
      );
      expect(point.attributes).toMatchObject({ "http.request.method": "GET", "http.response.status_code": 200 });
      expect(JSON.stringify(point.attributes)).not.toContain(cinema.sessionId);
    });

    it("AC4: deve gerar span de query do Postgres filho da request, sem os valores dos parâmetros", async () => {
      // GIVEN a API exportando telemetria

      // WHEN uma request consulta o banco
      await getSeatMap(api, guestToken, cinema.sessionId);

      // THEN as queries viram spans CLIENT do Postgres dentro do trace da request
      const request = await waitForServerSpan(collector, "GET", "/sessions/:id/seats");
      const queries = await waitFor("spans do Postgres da request", () => {
        const found = spansOfTrace(collector, request.traceId).filter(
          (span) => span.attributes["db.system.name"] === "postgresql",
        );
        return found.length > 0 ? found : undefined;
      });
      for (const query of queries) {
        expect(query.kind).toBe(OTLP_SPAN_KIND.CLIENT);
        expect(isDescendantOf(collector, query, request)).toBe(true);
        expect(query.attributes["db.query.text"]).toEqual(expect.stringContaining("$1"));
        expect(JSON.stringify(query.attributes)).not.toContain(cinema.sessionId);
      }
      expect(queries.map((query) => query.name)).toContain("SELECT sessions");
      await waitFor("db.client.operation.duration", () => collector.dataPoints("db.client.operation.duration")[0]);
    });

    it("AC5: deve gerar span de comando do Valkey sem chave nem valor", async () => {
      // GIVEN a API exportando telemetria

      // WHEN um convidado segura um assento (SET NX no Valkey)
      const response = await holdSeat(api, guestToken, cinema.sessionId, cinema.seatId);

      // THEN os comandos viram spans com o nome do comando e nenhum id de chave/valor
      expect(response.status).toBe(200);
      const request = await waitForServerSpan(collector, "POST", "/sessions/:id/seats/:seatId/hold");
      const commands = await waitFor("spans do Valkey da request", () => {
        const found = spansOfTrace(collector, request.traceId).filter(
          (span) => span.attributes["db.system.name"] === "redis",
        );
        return found.some((span) => span.name === "set") ? found : undefined;
      });
      for (const command of commands) {
        const exported = JSON.stringify(command);
        expect(exported).not.toContain(cinema.sessionId);
        expect(exported).not.toContain(cinema.seatId);
        expect(exported).not.toContain("guest:");
      }
    });

    it("AC6: deve exportar o log da request com o trace_id do span", async () => {
      // GIVEN a API exportando telemetria

      // WHEN o catálogo é consultado
      await listMovies(api);

      // THEN o log "request completed" sai via OTLP com o trace_id/span_id do span da request
      const request = await waitForServerSpan(collector, "GET", "/movies");
      const log = await waitForLogOfTrace(collector, request.traceId);
      expect(log.spanId).toBe(request.spanId);
      expect(log.body).toBe("request completed");
    });

    it("AC7: não deve exportar o header Authorization nem a senha no log ou no span", async () => {
      // GIVEN segredos únicos pra procurar no que foi exportado
      const secrets = {
        authorization: `Bearer jwt-${randomUUID()}`,
        cookie: `sid=cookie-${randomUUID()}`,
        email: `observability-${randomUUID()}@test.com`,
        password: `senha-${randomUUID()}`,
      };

      // WHEN um login (que falha) é feito carregando esses segredos
      const response = await attemptLoginWithSecrets(api, secrets);

      // THEN nem logs nem spans exportados contêm algum deles
      expect(response.status).toBe(401);
      const request = await waitForServerSpan(collector, "POST", "/auth/login");
      await waitForLogOfTrace(collector, request.traceId);
      await waitFor("spans do Postgres do login", () =>
        spansOfTrace(collector, request.traceId).find((span) => span.attributes["db.system.name"] === "postgresql"),
      );
      const exported = collector.rawPayloads();
      expect(exported).toContain("[Redacted]");
      for (const secret of Object.values(secrets)) {
        expect(exported).not.toContain(secret.replace(/^Bearer |^sid=/, ""));
      }
    });

    it("AC7: não deve exportar IP nem user agent do cliente nos spans", async () => {
      // GIVEN a API exportando telemetria

      // WHEN uma request chega com user agent
      await fetch(`${api.baseUrl}/observability-smoke-ua`, { headers: { "user-agent": "SmokeBrowser/1.0" } });

      // THEN o span SERVER sai sem client.address, network.peer.address e user_agent.original
      const request = await waitFor("span SERVER da request com user agent", () =>
        collector
          .spans()
          .find(
            (span) => span.kind === OTLP_SPAN_KIND.SERVER && span.attributes["url.path"] === "/observability-smoke-ua",
          ),
      );
      expect(request.attributes).not.toHaveProperty("client.address");
      expect(request.attributes).not.toHaveProperty("network.peer.address");
      expect(request.attributes).not.toHaveProperty("user_agent.original");
      expect(JSON.stringify(collector.spans())).not.toContain("SmokeBrowser/1.0");
    });

    it("AC7: não deve exportar IP nem user agent do cliente nos logs, nem no OTLP nem no stdout", async () => {
      // GIVEN a API exportando telemetria e uma request com user agent e cabeçalhos de proxy
      const headers = {
        "user-agent": "SmokeLogBrowser/1.0",
        "x-forwarded-for": "203.0.113.77",
        "x-real-ip": "203.0.113.77",
      };

      // WHEN a request chega
      await fetch(`${api.baseUrl}/observability-smoke-log-privacy`, { headers });

      // THEN o log "request completed" existe, mas sem IP, porta nem user agent (OTLP e stdout)
      const request = await waitFor("span SERVER da request de privacidade de logs", () =>
        collector
          .spans()
          .find(
            (span) =>
              span.kind === OTLP_SPAN_KIND.SERVER && span.attributes["url.path"] === "/observability-smoke-log-privacy",
          ),
      );
      const log = await waitForLogOfTrace(collector, request.traceId);
      expect(log.body).toBe("request completed");
      const exportedLogs = JSON.stringify(collector.logRecords());
      const stdout = api.output();
      expect(stdout).toContain("/observability-smoke-log-privacy");
      for (const text of [exportedLogs, stdout]) {
        expect(text).not.toContain("SmokeLogBrowser");
        expect(text).not.toContain("203.0.113.77");
        expect(text).not.toContain("remoteAddress");
        expect(text).not.toContain("remotePort");
        expect(text).not.toContain("user-agent");
      }
    });
  });

  describe("desligamento", () => {
    it("AC15: deve enviar os dados pendentes ao receber SIGTERM", async () => {
      // GIVEN a API com intervalos de export longos (nada sairia sozinho durante o teste)
      const collector = await startFakeOtlpCollector();
      const api = await startApiWithTelemetry(slowExportEnv(collector));
      try {
        await listMovies(api);
        expect(collector.requestCount()).toBe(0);

        // WHEN ela recebe SIGTERM
        const exit = await api.stop("SIGTERM");

        // THEN sai em até 5 s depois de enviar spans, métricas e logs pendentes
        expect(exit.elapsedMs).toBeLessThan(5_000);
        expect(exit.signal === "SIGTERM" || exit.code === 143).toBe(true);
        const request = await waitForServerSpan(collector, "GET", "/movies", 1_000);
        await waitForLogOfTrace(collector, request.traceId);
        expect(collector.dataPoints("http.server.request.duration").length).toBeGreaterThan(0);
      } finally {
        await api.stop();
        await collector.close();
      }
    });
  });
});
