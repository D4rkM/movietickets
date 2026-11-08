import { randomUUID } from "node:crypto";
import { CinemaFixture, createCinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import {
  callAs,
  clearSessionHolds,
  GuestIdentity,
  holdSeatAs,
  obtainGuestIdentity,
  readSeatMapAs,
  releaseAllHoldsAs,
  releaseSeatAs,
  requestGuestToken,
} from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";

// Spec: docs/flows/public-catalog-login-gate/spec.md (AC2, AC17, guest token rate limit)
describe("Acesso de convidado (e2e)", () => {
  let ctx: GuestFlowApp;
  let fixture: CinemaFixture;
  let sessionId: string;
  let user: TestUser;
  let guest: GuestIdentity;
  const unknownBookingId = randomUUID();

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    fixture = await createCinemaFixture(ctx.db, `Guest Access E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    user = await createUserWithPassword(ctx.db, "guest-access-e2e");
  });

  beforeEach(async () => {
    guest = await obtainGuestIdentity(ctx.app, ctx.jwtService);
  });

  afterEach(async () => {
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await fixture.cleanup();
    await deleteUsers(ctx.db, [user]);
    await ctx.close();
  });

  it("AC2: deve emitir token de convidado com kind guest, sub guest:<uuid> e validade de 2h", async () => {
    // GIVEN um visitante sem nenhum token

    // WHEN ele pede uma identidade de convidado
    const response = await requestGuestToken(ctx.app);

    // THEN recebe um token de convidado de 2h
    expect(response.statusCode).toBe(200);
    const { guestToken, expiresAt } = response.json();
    const payload = ctx.jwtService.decode<{ kind: string; sub: string; iat: number; exp: number }>(guestToken);
    expect(payload.kind).toBe("guest");
    expect(payload.sub).toMatch(/^guest:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.exp - payload.iat).toBe(2 * 60 * 60);
    expect(new Date(expiresAt).getTime()).toBe(payload.exp * 1000);
  });

  it("AC2: deve aceitar token de convidado em GET /sessions/:id/seats", async () => {
    // GIVEN um convidado

    // WHEN ele lê o mapa de assentos
    const response = await readSeatMapAs(ctx.app, guest.guestToken, sessionId);

    // THEN o mapa é retornado
    expect(response.statusCode).toBe(200);
  });

  it("AC2: deve aceitar token de convidado em POST /sessions/:id/seats/:seatId/hold", async () => {
    // GIVEN um convidado e um assento livre
    const [seatId] = await fixture.addSeats(1);

    // WHEN ele segura o assento
    const response = await holdSeatAs(ctx.app, guest.guestToken, sessionId, seatId);

    // THEN o hold é criado
    expect(response.statusCode).toBe(200);
  });

  it("AC2: deve aceitar token de convidado em DELETE /sessions/:id/seats/:seatId/hold", async () => {
    // GIVEN um convidado segurando um assento
    const [seatId] = await fixture.addSeats(1);
    await holdSeatAs(ctx.app, guest.guestToken, sessionId, seatId);

    // WHEN ele libera o assento
    const response = await releaseSeatAs(ctx.app, guest.guestToken, sessionId, seatId);

    // THEN o hold é liberado
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seatId, released: true });
  });

  it("AC2: deve aceitar token de convidado em DELETE /sessions/:id/holds", async () => {
    // GIVEN um convidado segurando um assento
    const [seatId] = await fixture.addSeats(1);
    await holdSeatAs(ctx.app, guest.guestToken, sessionId, seatId);

    // WHEN ele libera todos os seus holds da sessão
    const response = await releaseAllHoldsAs(ctx.app, guest.guestToken, sessionId);

    // THEN o hold dele é liberado
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ releasedSeatIds: [seatId] });
  });

  it("AC2: deve recusar token de convidado com 401 em POST /sessions/:id/book", async () => {
    // GIVEN um convidado e um assento
    const [seatId] = await fixture.addSeats(1);

    // WHEN ele tenta reservar
    const response = await callAs(ctx.app, guest.guestToken, "POST", `/sessions/${sessionId}/book`, {
      seats: [{ seatId, ticketType: "full" }],
    });

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC2: deve recusar token de convidado com 401 em POST /sessions/:id/seats/:seatId/book", async () => {
    // GIVEN um convidado e um assento
    const [seatId] = await fixture.addSeats(1);

    // WHEN ele tenta reservar o assento
    const response = await callAs(ctx.app, guest.guestToken, "POST", `/sessions/${sessionId}/seats/${seatId}/book`, {
      ticketType: "full",
    });

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC2: deve recusar token de convidado com 401 em POST /bookings/:id/checkout", async () => {
    // GIVEN um convidado

    // WHEN ele tenta iniciar o pagamento de uma reserva
    const response = await callAs(ctx.app, guest.guestToken, "POST", `/bookings/${unknownBookingId}/checkout`);

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC2: deve recusar token de convidado com 401 em POST /bookings/:id/confirm", async () => {
    // GIVEN um convidado

    // WHEN ele tenta confirmar uma reserva
    const response = await callAs(ctx.app, guest.guestToken, "POST", `/bookings/${unknownBookingId}/confirm`);

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC2: deve recusar token de convidado com 401 em POST /bookings/:id/cancel", async () => {
    // GIVEN um convidado

    // WHEN ele tenta cancelar uma reserva
    const response = await callAs(ctx.app, guest.guestToken, "POST", `/bookings/${unknownBookingId}/cancel`);

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC2: deve recusar token de convidado com 401 em GET /bookings/mine", async () => {
    // GIVEN um convidado

    // WHEN ele tenta listar ingressos
    const response = await callAs(ctx.app, guest.guestToken, "GET", "/bookings/mine");

    // THEN é recusado com 401
    expect(response.statusCode).toBe(401);
  });

  it("AC17: deve aceitar token de usuário emitido antes da feature (sem kind) em GET /bookings/mine", async () => {
    // GIVEN um token de usuário antigo, sem o campo kind
    const legacyToken = ctx.jwtService.sign({ sub: user.id, email: user.email, role: "customer" });

    // WHEN o usuário lista seus ingressos
    const response = await callAs(ctx.app, legacyToken, "GET", "/bookings/mine");

    // THEN a rota de usuário aceita o token
    expect(response.statusCode).toBe(200);
  });

  it("deve limitar POST /auth/guest a 10 requisições por minuto por IP", async () => {
    // GIVEN um IP que já pediu 10 tokens de convidado no último minuto
    const clientIp = "203.0.113.77";
    for (let i = 0; i < 10; i++) {
      const response = await requestGuestToken(ctx.app, clientIp);
      expect(response.statusCode).toBe(200);
    }

    // WHEN o mesmo IP pede o 11º token
    const blocked = await requestGuestToken(ctx.app, clientIp);

    // THEN é recusado com 429, enquanto outro IP continua sendo atendido
    expect(blocked.statusCode).toBe(429);
    const otherIp = await requestGuestToken(ctx.app, "203.0.113.78");
    expect(otherIp.statusCode).toBe(200);
  });
});
