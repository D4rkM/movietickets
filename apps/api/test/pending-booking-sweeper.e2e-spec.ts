import { PendingBookingSweeper } from "../src/booking/pending-booking.sweeper";
import { DRIZZLE } from "../src/db/drizzle.module";
import { SeatingGateway } from "../src/seating/seating.gateway";
import { CinemaFixture, createCinemaFixture, createUserWithPassword, deleteUsers, TestUser } from "./helpers/cinema-fixture";
import { SeatingWatcher, watchSessionAs } from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";
import {
  backdateBooking,
  captureWarnings,
  deletePaymentsOfSessions,
  expireDeadlineOf,
  insertBooking,
  readBooking,
  recordPayment,
  seatIdsOf,
  settle,
} from "./helpers/pending-booking";

// Spec: docs/flows/pending-booking-expiry/spec.md (sweeper: AC8-AC10, AC20)
describe("Sweeper de reservas pendentes (e2e)", () => {
  let ctx: GuestFlowApp;
  let fixture: CinemaFixture;
  let sessionId: string;
  let owner: TestUser;
  let viewerToken: string;
  let sweeper: PendingBookingSweeper;
  let watcher: SeatingWatcher;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    fixture = await createCinemaFixture(ctx.db, `Pending Sweeper E2E ${Date.now()}`);
    [sessionId] = fixture.sessionIds;
    owner = await createUserWithPassword(ctx.db, "sweeper-owner");
    viewerToken = ctx.jwtService.sign({ kind: "user", sub: owner.id, email: owner.email, role: "customer" });
    sweeper = ctx.app.get(PendingBookingSweeper);
  });

  beforeEach(async () => {
    watcher = await watchSessionAs(ctx.baseUrl, viewerToken, sessionId);
  });

  afterEach(() => {
    watcher.close();
  });

  afterAll(async () => {
    await deletePaymentsOfSessions(ctx.db, fixture.sessionIds);
    await fixture.cleanup();
    await deleteUsers(ctx.db, [owner]);
    await ctx.close();
  });

  /** A second sweeper over the same DB and gateway, simulating another API instance. */
  function anotherInstance(): PendingBookingSweeper {
    return new PendingBookingSweeper(ctx.app.get(DRIZZLE), ctx.app.get(SeatingGateway));
  }

  async function booking(seatIds: string[], status = "pending"): Promise<string> {
    return insertBooking(ctx.db, { userId: owner.id, sessionId, seatIds, status });
  }

  function releasedCount(seatId: string): number {
    return watcher.updates.filter((update) => update.seatId === seatId && update.status === "released").length;
  }

  it("AC8: deve expirar reserva vencida, apagar os assentos e avisar a sala da sessão", async () => {
    // GIVEN uma reserva pendente vencida, sem pagamento, com dois assentos
    const seatIds = await fixture.addSeats(2);
    const bookingId = await booking(seatIds);
    await expireDeadlineOf(ctx.db, bookingId);

    // WHEN o sweeper roda
    await sweeper.run();

    // THEN a reserva vira expirada, perde os assentos e a sala recebe "released" por assento
    expect((await readBooking(ctx.db, bookingId)).status).toBe("expired");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([]);
    for (const seatId of seatIds) {
      await watcher.waitFor((update) => update.seatId === seatId && update.status === "released");
    }
  });

  it("AC9: não deve expirar reserva pendente dentro do prazo", async () => {
    // GIVEN uma reserva pendente dentro do prazo
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId]);

    // WHEN o sweeper roda
    await sweeper.run();

    // THEN a reserva continua pendente com o assento
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC9: não deve expirar reserva vencida com pagamento em andamento", async () => {
    // GIVEN uma reserva pendente vencida com pagamento in_process
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId]);
    await recordPayment(ctx.db, bookingId, "in_process");
    await expireDeadlineOf(ctx.db, bookingId);

    // WHEN o sweeper roda
    await sweeper.run();

    // THEN a reserva continua pendente com o assento
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC9: não deve mexer em reserva confirmada", async () => {
    // GIVEN uma reserva confirmada com expires_at no passado
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId], "confirmed");
    await expireDeadlineOf(ctx.db, bookingId);

    // WHEN o sweeper roda
    await sweeper.run();

    // THEN a reserva continua confirmada com o assento
    expect((await readBooking(ctx.db, bookingId)).status).toBe("confirmed");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC9: não deve mexer em reserva cancelada", async () => {
    // GIVEN uma reserva cancelada com expires_at no passado
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId], "cancelled");
    await expireDeadlineOf(ctx.db, bookingId);

    // WHEN o sweeper roda
    await sweeper.run();

    // THEN a reserva continua cancelada com o assento
    expect((await readBooking(ctx.db, bookingId)).status).toBe("cancelled");
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
  });

  it("AC10: deve expirar cada reserva uma única vez com duas execuções simultâneas do sweeper", async () => {
    // GIVEN duas reservas pendentes vencidas e duas instâncias do sweeper
    const [firstSeatId, secondSeatId] = await fixture.addSeats(2);
    const firstBookingId = await booking([firstSeatId]);
    const secondBookingId = await booking([secondSeatId]);
    await expireDeadlineOf(ctx.db, firstBookingId);
    await expireDeadlineOf(ctx.db, secondBookingId);

    // WHEN as duas instâncias rodam ao mesmo tempo
    const results = await Promise.all([sweeper.run(), anotherInstance().run()]);

    // THEN cada reserva é expirada por uma única instância e cada assento recebe um único "released"
    const expiredIds = results.flatMap((result) => result?.expiredBookingIds ?? []);
    expect(expiredIds.filter((id) => id === firstBookingId)).toHaveLength(1);
    expect(expiredIds.filter((id) => id === secondBookingId)).toHaveLength(1);
    await settle();
    expect(releasedCount(firstSeatId)).toBe(1);
    expect(releasedCount(secondSeatId)).toBe(1);
  });

  it("AC20: deve alertar uma única vez a reserva com pagamento em andamento há mais de 24h sem expirá-la", async () => {
    // GIVEN uma reserva pendente criada há 25h com pagamento in_process
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId]);
    await backdateBooking(ctx.db, bookingId, 25);
    await recordPayment(ctx.db, bookingId, "in_process");
    const warnings = captureWarnings();

    // WHEN o sweeper roda duas vezes seguidas
    await sweeper.run();
    await sweeper.run();

    // THEN a reserva continua pendente com o assento, marcada como alertada, com um único aviso
    warnings.restore();
    const stored = await readBooking(ctx.db, bookingId);
    expect(stored.status).toBe("pending");
    expect(stored.stalePaymentAlertedAt).not.toBeNull();
    expect(await seatIdsOf(ctx.db, bookingId)).toEqual([seatId]);
    expect(warnings.mentioning(bookingId)).toHaveLength(1);
  });

  it("AC20: deve alertar uma única vez mesmo com duas execuções simultâneas do sweeper", async () => {
    // GIVEN uma reserva pendente criada há 25h com pagamento pending
    const [seatId] = await fixture.addSeats(1);
    const bookingId = await booking([seatId]);
    await backdateBooking(ctx.db, bookingId, 25);
    await recordPayment(ctx.db, bookingId, "pending");
    const warnings = captureWarnings();

    // WHEN duas instâncias rodam ao mesmo tempo e depois mais uma vez
    await Promise.all([sweeper.run(), anotherInstance().run()]);
    await sweeper.run();

    // THEN só um aviso é registrado e a reserva continua pendente
    warnings.restore();
    expect(warnings.mentioning(bookingId)).toHaveLength(1);
    expect((await readBooking(ctx.db, bookingId)).status).toBe("pending");
  });
});
