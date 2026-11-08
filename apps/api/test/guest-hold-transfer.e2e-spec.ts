import { CinemaFixture, createCinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import {
  ageHold,
  clearSessionHolds,
  expireHoldNow,
  GuestIdentity,
  holdOwner,
  holdOwners,
  holdRemainingMs,
  holdSeatsAs,
  loginWith,
  obtainGuestIdentity,
  seatStatusSeenBy,
  signGuestToken,
  watchSessionAs,
} from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";

// Spec: docs/flows/public-catalog-login-gate/spec.md (AC6, AC7, AC10, AC13, AC14)
describe("Transferência de holds do convidado no login (e2e)", () => {
  let ctx: GuestFlowApp;
  let fixture: CinemaFixture;
  let sessionId: string;
  let otherSessionId: string;
  let user: TestUser;
  let userToken: string;
  let guest: GuestIdentity;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    fixture = await createCinemaFixture(ctx.db, `Guest Transfer E2E ${Date.now()}`, 2);
    [sessionId, otherSessionId] = fixture.sessionIds;
    user = await createUserWithPassword(ctx.db, "guest-transfer-e2e");
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

  it("AC6: deve passar os holds ativos do convidado pro usuário preservando o TTL restante", async () => {
    // GIVEN um convidado segurando 2 assentos
    const seatIds = await fixture.addSeats(2);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, seatIds);
    const pttlBefore = await holdRemainingMs(ctx.valkey, sessionId, seatIds[0]);

    // WHEN ele loga enviando o guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN os holds passam pro usuário, com PTTL depois <= antes e > 0
    expect(response.statusCode).toBe(200);
    expect(await holdOwners(ctx.valkey, sessionId, seatIds)).toEqual([user.id, user.id]);
    const pttlAfter = await holdRemainingMs(ctx.valkey, sessionId, seatIds[0]);
    expect(pttlAfter).toBeGreaterThan(0);
    expect(pttlAfter).toBeLessThanOrEqual(pttlBefore);
    expect(response.json().transfer).toEqual({
      keptSeats: expect.arrayContaining(seatIds.map((seatId) => ({ sessionId, seatId }))),
      releasedSeats: [],
    });
  });

  it("AC6: deve mostrar os assentos transferidos como held_by_me pro usuário logado", async () => {
    // GIVEN um convidado segurando um assento
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // WHEN ele loga com o guestToken e lê o mapa com o token de usuário
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });
    const status = await seatStatusSeenBy(ctx.app, response.json().accessToken, sessionId, seatId);

    // THEN o assento aparece como held_by_me
    expect(status).toBe("held_by_me");
  });

  it("AC6: deve emitir broadcast held com o novo dono pra cada assento transferido", async () => {
    // GIVEN um convidado segurando um assento e outro cliente assistindo a sessão
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);
    const watcher = await watchSessionAs(ctx.baseUrl, userToken, sessionId);

    // WHEN o convidado loga com o guestToken
    await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN a room recebe o held com o usuário como dono
    const update = await watcher.waitFor((u) => u.seatId === seatId && u.heldByUserId === user.id);
    expect(update).toEqual({ seatId, status: "held", heldByUserId: user.id });
    watcher.close();
  });

  it("AC7: deve reportar hold expirado em releasedSeats com reason expired e não recriar a chave", async () => {
    // GIVEN um convidado com 2 holds, um deles já expirado antes do login
    const [expiredSeatId, activeSeatId] = await fixture.addSeats(2);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [expiredSeatId, activeSeatId]);
    await expireHoldNow(ctx.valkey, sessionId, expiredSeatId);

    // WHEN ele loga com o guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN o expirado vem em releasedSeats e continua sem chave; o ativo é transferido
    expect(response.statusCode).toBe(200);
    expect(response.json().transfer).toEqual({
      keptSeats: [{ sessionId, seatId: activeSeatId }],
      releasedSeats: [{ sessionId, seatId: expiredSeatId, reason: "expired" }],
    });
    expect(await holdOwner(ctx.valkey, sessionId, expiredSeatId)).toBeNull();
    expect(await holdOwner(ctx.valkey, sessionId, activeSeatId)).toBe(user.id);
  });

  it("AC10: deve logar normalmente e não transferir nada com guestToken expirado", async () => {
    // GIVEN um convidado com hold e um guestToken dele já expirado
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);
    const expiredGuestToken = signGuestToken(ctx.jwtService, guest.holderId, -60);

    // WHEN ele loga com o token expirado
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: expiredGuestToken });

    // THEN o login funciona, sem transfer, e o hold continua com o convidado
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
    expect(response.json()).not.toHaveProperty("transfer");
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(guest.holderId);
  });

  it("AC10: deve logar normalmente e não transferir nada com guestToken inválido", async () => {
    // GIVEN um convidado com hold e um guestToken adulterado
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // WHEN ele loga com um token que não é um JWT válido
    const response = await loginWith(ctx.app, {
      email: user.email,
      password: user.password,
      guestToken: `${guest.guestToken}adulterado`,
    });

    // THEN o login funciona, sem transfer, e o hold continua com o convidado
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
    expect(response.json()).not.toHaveProperty("transfer");
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(guest.holderId);
  });

  it("AC10: deve logar normalmente e não transferir nada com guestToken já usado numa transferência anterior", async () => {
    // GIVEN um guestToken já consumido num login anterior e um novo hold feito depois com ele
    const [firstSeatId, laterSeatId] = await fixture.addSeats(2);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [firstSeatId]);
    await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [laterSeatId]);

    // WHEN alguém loga de novo com o mesmo guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN o login funciona, sem transfer, e o novo hold não muda de dono
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
    expect(response.json()).not.toHaveProperty("transfer");
    expect(await holdOwner(ctx.valkey, sessionId, laterSeatId)).toBe(guest.holderId);
  });

  it("AC10: deve logar normalmente e não transferir nada com guestToken de kind user", async () => {
    // GIVEN um convidado com hold e um token de usuário enviado no lugar do guestToken
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // WHEN o login recebe um token kind user como guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: userToken });

    // THEN o login funciona, sem transfer, e o hold continua com o convidado
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
    expect(response.json()).not.toHaveProperty("transfer");
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(guest.holderId);
  });

  it("AC13: deve manter os 4 do convidado + 2 mais novos do usuário e liberar os 2 mais antigos com reason limit e broadcast released", async () => {
    // GIVEN o usuário com 4 holds de idades diferentes e o convidado com 4 holds na mesma sessão
    const userSeatIds = await fixture.addSeats(4);
    const guestSeatIds = await fixture.addSeats(4);
    await holdSeatsAs(ctx.app, userToken, sessionId, userSeatIds);
    const [oldest, older, newer, newest] = userSeatIds;
    await ageHold(ctx.valkey, sessionId, oldest, 100_000);
    await ageHold(ctx.valkey, sessionId, older, 200_000);
    await ageHold(ctx.valkey, sessionId, newer, 300_000);
    await ageHold(ctx.valkey, sessionId, newest, 400_000);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, guestSeatIds);
    const watcher = await watchSessionAs(ctx.baseUrl, userToken, sessionId);

    // WHEN o convidado loga com o guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN ficam os 4 do convidado + os 2 mais novos do usuário; os 2 mais antigos são liberados
    expect(response.statusCode).toBe(200);
    const { transfer } = response.json();
    expect(transfer.keptSeats).toEqual(expect.arrayContaining(guestSeatIds.map((seatId) => ({ sessionId, seatId }))));
    expect(transfer.keptSeats).toHaveLength(4);
    expect(transfer.releasedSeats).toEqual(
      expect.arrayContaining([
        { sessionId, seatId: oldest, reason: "limit" },
        { sessionId, seatId: older, reason: "limit" },
      ]),
    );
    expect(transfer.releasedSeats).toHaveLength(2);
    expect(await holdOwners(ctx.valkey, sessionId, guestSeatIds)).toEqual([user.id, user.id, user.id, user.id]);
    expect(await holdOwners(ctx.valkey, sessionId, [newer, newest])).toEqual([user.id, user.id]);
    expect(await holdOwners(ctx.valkey, sessionId, [oldest, older])).toEqual([null, null]);
    await watcher.waitFor((u) => u.seatId === oldest && u.status === "released");
    await watcher.waitFor((u) => u.seatId === older && u.status === "released");
    watcher.close();
  });

  it("AC13: não deve mexer nos holds do usuário em outra sessão durante a transferência", async () => {
    // GIVEN o usuário com 4 holds em outra sessão e 4 na sessão do convidado, e o convidado com 4 holds
    const otherSessionSeatIds = await fixture.addSeats(4);
    const userSeatIds = await fixture.addSeats(4);
    const guestSeatIds = await fixture.addSeats(4);
    await holdSeatsAs(ctx.app, userToken, otherSessionId, otherSessionSeatIds);
    await holdSeatsAs(ctx.app, userToken, sessionId, userSeatIds);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, guestSeatIds);

    // WHEN o convidado loga com o guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: user.password, guestToken: guest.guestToken });

    // THEN os holds da outra sessão continuam intactos e fora do relatório
    expect(response.statusCode).toBe(200);
    expect(await holdOwners(ctx.valkey, otherSessionId, otherSessionSeatIds)).toEqual([
      user.id,
      user.id,
      user.id,
      user.id,
    ]);
    const releasedSessions = response.json().transfer.releasedSeats.map((seat: { sessionId: string }) => seat.sessionId);
    expect(releasedSessions).not.toContain(otherSessionId);
  });

  it("AC14: não deve transferir nada quando a senha está errada, mesmo com guestToken válido", async () => {
    // GIVEN um convidado segurando um assento
    const [seatId] = await fixture.addSeats(1);
    await holdSeatsAs(ctx.app, guest.guestToken, sessionId, [seatId]);

    // WHEN ele tenta logar com a senha errada enviando o guestToken
    const response = await loginWith(ctx.app, { email: user.email, password: "senha-errada", guestToken: guest.guestToken });

    // THEN o login falha e o hold continua com o convidado
    expect(response.statusCode).toBe(401);
    expect(await holdOwner(ctx.valkey, sessionId, seatId)).toBe(guest.holderId);
  });
});
