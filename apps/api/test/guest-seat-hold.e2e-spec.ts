import { CinemaFixture, createCinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import {
  clearSessionHolds,
  GuestIdentity,
  holdOwner,
  holdSeatAs,
  holdSeatsAs,
  obtainGuestIdentity,
  releaseSeatAs,
  seatStatusSeenBy,
  staysConnected,
  watchSessionAs,
} from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";

// Spec: docs/flows/public-catalog-login-gate/spec.md (AC3, AC4, AC11, AC12)
describe("Hold de assento por convidado (e2e)", () => {
  let ctx: GuestFlowApp;
  let fixture: CinemaFixture;
  let sessionId: string;
  let user: TestUser;
  let userToken: string;
  let guest: GuestIdentity;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    fixture = await createCinemaFixture(ctx.db, `Guest Hold E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    user = await createUserWithPassword(ctx.db, "guest-hold-e2e");
    userToken = ctx.jwtService.sign({ kind: "user", sub: user.id, email: user.email, role: "customer" });
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

  it("AC3: deve criar o hold do convidado com valor guest:<uuid>", async () => {
    // GIVEN um convidado e um assento livre
    const [seatId] = await fixture.addSeats(1);

    // WHEN o convidado clica no assento
    const response = await holdSeatAs(ctx.app, guest.guestToken, sessionId, seatId);

    // THEN o hold existe na Valkey com o convidado como dono
    expect(response.statusCode).toBe(200);
    expect(guest.holderId).toMatch(/^guest:/);
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(guest.holderId);
  });

  it("AC3: deve mostrar o assento como held_by_me pro convidado e held_by_other pros outros", async () => {
    // GIVEN um assento segurado pelo convidado
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // WHEN o convidado e um usuário logado leem o mapa
    const seenByGuest = await seatStatusSeenBy(ctx.app, guest.guestToken, sessionId, seatId);
    const seenByUser = await seatStatusSeenBy(ctx.app, userToken, sessionId, seatId);

    // THEN cada um vê o estado do seu ponto de vista
    expect(seenByGuest).toBe("held_by_me");
    expect(seenByUser).toBe("held_by_other");
  });

  it("AC3: deve emitir o broadcast held pra room da sessão quando o convidado segura um assento", async () => {
    // GIVEN um usuário assistindo a sessão pelo WebSocket
    const [seatId] = await fixture.addSeats(1);
    const watcher = await watchSessionAs(ctx.baseUrl, userToken, sessionId);

    // WHEN o convidado segura o assento
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // THEN a room recebe o held com o convidado como dono
    const update = await watcher.waitFor((u) => u.seatId === seatId);
    expect(update).toEqual({ seatId, status: "held", heldByUserId: guest.holderId });
    watcher.close();
  });

  it("AC4: deve recusar com 409 o 7º hold simultâneo do convidado na mesma sessão", async () => {
    // GIVEN um convidado que já segura 6 assentos na sessão
    const seatIds = await fixture.addSeats(7);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, seatIds.slice(0, 6));

    // WHEN ele tenta segurar o 7º assento
    const response = await holdSeatAs(ctx.app, guest.guestToken, sessionId, seatIds[6]);

    // THEN é recusado com 409 e o 7º assento continua livre
    expect(response.statusCode).toBe(409);
    expect(await holdOwner(ctx.valkey, sessionId, seatIds[6])).toBeNull();
  });

  it("AC11: deve aceitar o handshake WebSocket com token de convidado", async () => {
    // GIVEN um convidado

    // WHEN ele conecta no gateway de assentos
    const watcher = await watchSessionAs(ctx.baseUrl, guest.guestToken, sessionId);

    // THEN a conexão não é derrubada pelo servidor
    expect(await staysConnected(watcher.socket)).toBe(true);
    watcher.close();
  });

  it("AC11: deve entregar ao convidado o broadcast quando outro cliente segura um assento", async () => {
    // GIVEN um convidado na room da sessão
    const [seatId] = await fixture.addSeats(1);
    const guestWatcher = await watchSessionAs(ctx.baseUrl, guest.guestToken, sessionId);

    // WHEN um usuário logado segura um assento
    await holdSeatsAs(ctx.app, userToken, sessionId, [seatId]);

    // THEN o convidado recebe o held
    const update = await guestWatcher.waitFor((u) => u.seatId === seatId);
    expect(update).toEqual({ seatId, status: "held", heldByUserId: user.id });
    guestWatcher.close();
  });

  it("AC11: deve entregar ao convidado o broadcast quando outro cliente libera um assento", async () => {
    // GIVEN um convidado na room e um assento segurado por um usuário logado
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, userToken, sessionId, [seatId]);
    const guestWatcher = await watchSessionAs(ctx.baseUrl, guest.guestToken, sessionId);

    // WHEN o usuário libera o assento
    await releaseSeatAs(ctx.app, userToken, sessionId, seatId);

    // THEN o convidado recebe o released
    const update = await guestWatcher.waitFor((u) => u.seatId === seatId && u.status === "released");
    expect(update).toEqual({ seatId, status: "released" });
    guestWatcher.close();
  });

  it("AC12: deve continuar criando hold de usuário logado e emitindo broadcast", async () => {
    // GIVEN um usuário logado e outro cliente assistindo a sessão
    const [seatId] = await fixture.addSeats(1);
    const watcher = await watchSessionAs(ctx.baseUrl, guest.guestToken, sessionId);

    // WHEN o usuário logado clica no assento
    const response = await holdSeatAs(ctx.app, userToken, sessionId, seatId);

    // THEN o hold é do usuário, ele vê held_by_me e a room recebe o held
    expect(response.statusCode).toBe(200);
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(user.id);
    expect(await seatStatusSeenBy(ctx.app, userToken, sessionId, seatId)).toBe("held_by_me");
    const update = await watcher.waitFor((u) => u.seatId === seatId);
    expect(update).toEqual({ seatId, status: "held", heldByUserId: user.id });
    watcher.close();
  });
});
