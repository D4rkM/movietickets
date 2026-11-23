import {
  CinemaFixture,
  createCinemaFixture,
  createUserWithPassword,
  deleteUsers,
  TestUser,
} from "./helpers/cinema-fixture";
import { clearSessionHolds, GuestIdentity, obtainGuestIdentity } from "./helpers/guest-flow";
import { GuestFlowApp, startGuestFlowApp } from "./helpers/guest-flow-app";
import { bookingStatusOf, bookSeatsAsOrFail, confirmMockedAs } from "./helpers/pending-booking";

// Spec: docs/flows/test-routes/spec.md
describe("Rotas de teste: confirmação mockada de reserva (e2e)", () => {
  let ctx: GuestFlowApp;
  let fixture: CinemaFixture;
  let user: TestUser;
  let userToken: string;
  const previousFlag = process.env.ENABLE_TEST_ROUTES;

  beforeAll(async () => {
    ctx = await startGuestFlowApp();
    fixture = await createCinemaFixture(ctx.db, `Test Routes E2E ${Date.now()}`);
    user = await createUserWithPassword(ctx.db, "test-routes-e2e");
    userToken = ctx.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: "customer",
    });
  });

  afterEach(async () => {
    if (previousFlag === undefined) delete process.env.ENABLE_TEST_ROUTES;
    else process.env.ENABLE_TEST_ROUTES = previousFlag;
    await clearSessionHolds(ctx.valkey, fixture.sessionIds);
  });

  afterAll(async () => {
    await fixture.cleanup();
    await deleteUsers(ctx.db, [user]);
    await ctx.close();
  });

  async function pendingBookingOfUser(): Promise<string> {
    const [seatId] = await fixture.addSeats(1);
    return bookSeatsAsOrFail(ctx.app, userToken, fixture.sessionIds[0], [seatId]);
  }

  it("AC1: deve responder 404 e manter a reserva pendente quando ENABLE_TEST_ROUTES não está ligada", async () => {
    // GIVEN a pending booking and the flag unset
    const bookingId = await pendingBookingOfUser();
    delete process.env.ENABLE_TEST_ROUTES;

    // WHEN the owner tries to confirm without paying
    const response = await confirmMockedAs(ctx.app, userToken, bookingId);

    // THEN the route "does not exist" and the booking stays pending
    expect(response.statusCode).toBe(404);
    expect(await bookingStatusOf(ctx.db, bookingId)).toBe("pending");
  });

  it("AC1: deve responder 404 quando ENABLE_TEST_ROUTES tem qualquer valor diferente de true", async () => {
    // GIVEN a pending booking and the flag set to a value other than "true"
    const bookingId = await pendingBookingOfUser();
    process.env.ENABLE_TEST_ROUTES = "1";

    // WHEN the owner tries to confirm
    const response = await confirmMockedAs(ctx.app, userToken, bookingId);

    // THEN the route stays disabled
    expect(response.statusCode).toBe(404);
    expect(await bookingStatusOf(ctx.db, bookingId)).toBe("pending");
  });

  it("AC2: deve confirmar a reserva pendente quando ENABLE_TEST_ROUTES=true", async () => {
    // GIVEN a pending booking and the flag enabled
    const bookingId = await pendingBookingOfUser();
    process.env.ENABLE_TEST_ROUTES = "true";

    // WHEN the owner confirms
    const response = await confirmMockedAs(ctx.app, userToken, bookingId);

    // THEN the booking becomes confirmed
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bookingId, status: "confirmed" });
    expect(await bookingStatusOf(ctx.db, bookingId)).toBe("confirmed");
  });

  it("AC3: deve recusar token de convidado com 401 quando ENABLE_TEST_ROUTES=true", async () => {
    // GIVEN a guest and the flag enabled
    const guest: GuestIdentity = await obtainGuestIdentity(ctx.app, ctx.jwtService);
    process.env.ENABLE_TEST_ROUTES = "true";

    // WHEN the guest tries to confirm a booking
    const response = await confirmMockedAs(ctx.app, guest.guestToken, "00000000-0000-0000-0000-000000000099");

    // THEN it is rejected because the caller is not a user
    expect(response.statusCode).toBe(401);
  });
});
