import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq, inArray } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AuthModule } from "../src/auth/auth.module";
import { BookingModule } from "../src/booking/booking.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { PAYMENT_CLIENT, PREFERENCE_CLIENT } from "../src/payment/mercadopago.providers";
import { PaymentModule } from "../src/payment/payment.module";
import { SeatingModule } from "../src/seating/seating.module";
import { ValkeyModule } from "../src/valkey/valkey.module";
import { buildFastifyApp } from "./helpers/build-app";

describe("Payment (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  let accessToken: string;

  const mockPreferenceClient = { create: jest.fn() };
  const mockPaymentClient = { get: jest.fn() };

  let userId: string;
  let movieId: string;
  let cinemaId: string;
  let roomId: string;
  let sessionId: string;
  let seatId: string;
  let bookingId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DrizzleModule,
        ValkeyModule,
        AuthModule,
        BookingModule,
        SeatingModule,
        PaymentModule,
      ],
    })
      .overrideProvider(PREFERENCE_CLIENT)
      .useValue(mockPreferenceClient)
      .overrideProvider(PAYMENT_CLIENT)
      .useValue(mockPaymentClient)
      .compile();

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ name: "Payment E2E User", email: "payment-e2e@test.com", passwordHash: "n/a" })
      .returning({ id: schema.users.id });
    accessToken = moduleRef.get(JwtService).sign({ sub: userId, email: "payment-e2e@test.com", role: "customer" });

    [{ id: movieId }] = await db
      .insert(schema.movies)
      .values({ title: "Payment E2E Movie", durationMinutes: 90 })
      .returning({ id: schema.movies.id });
    [{ id: cinemaId }] = await db
      .insert(schema.cinemas)
      .values({ name: "Payment E2E Cinema", address: "Rua Teste, 4", city: "Testópolis" })
      .returning({ id: schema.cinemas.id });
    [{ id: roomId }] = await db
      .insert(schema.rooms)
      .values({ cinemaId, name: "Sala Payment E2E", rows: 1, seatsPerRow: 1 })
      .returning({ id: schema.rooms.id });
    [{ id: seatId }] = await db
      .insert(schema.seats)
      .values({ roomId, rowLabel: "A", seatNumber: 1 })
      .returning({ id: schema.seats.id });
    [{ id: sessionId }] = await db
      .insert(schema.sessions)
      .values({ movieId, roomId, startsAt: new Date(Date.now() + 86_400_000), priceCents: 3000 })
      .returning({ id: schema.sessions.id });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db.delete(schema.payments);
    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, sessionId));
    await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, sessionId));

    [{ id: bookingId }] = await db
      .insert(schema.bookings)
      .values({ userId, sessionId, status: "pending" })
      .returning({ id: schema.bookings.id });
    await db.insert(schema.bookingSeats).values({
      bookingId,
      sessionId,
      seatId,
      ticketType: "full",
      priceCents: 3000,
    });
  });

  afterAll(async () => {
    await db.delete(schema.payments);
    await db.delete(schema.bookingSeats).where(eq(schema.bookingSeats.sessionId, sessionId));
    await db.delete(schema.bookings).where(eq(schema.bookings.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    await db.delete(schema.seats).where(inArray(schema.seats.roomId, [roomId]));
    await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId));
    await db.delete(schema.cinemas).where(eq(schema.cinemas.id, cinemaId));
    await db.delete(schema.movies).where(eq(schema.movies.id, movieId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await cleanupClient.end();
    await app.close();
  });

  describe("POST /bookings/:id/checkout", () => {
    it("should return the Mercado Pago checkout url for the owner's pending booking", async () => {
      // GIVEN a pending booking owned by the user and a Mercado Pago preference client that returns an init_point
      mockPreferenceClient.create.mockResolvedValue({ init_point: "https://mp.test/checkout/xyz" });

      // WHEN the user starts checkout
      const response = await app.inject({
        method: "POST",
        url: `/bookings/${bookingId}/checkout`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      // THEN the response carries the checkout url and the preference references the booking
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ checkoutUrl: "https://mp.test/checkout/xyz" });
      expect(mockPreferenceClient.create.mock.calls[0][0].body.external_reference).toBe(bookingId);
    });

    it("should return 401 without a JWT", async () => {
      // GIVEN a pending booking and no Authorization header

      // WHEN the checkout is requested anonymously
      const response = await app.inject({ method: "POST", url: `/bookings/${bookingId}/checkout` });

      // THEN the request is rejected
      expect(response.statusCode).toBe(401);
      expect(mockPreferenceClient.create).not.toHaveBeenCalled();
    });
  });

  describe("POST /payments/webhook", () => {
    it("should confirm the booking and record the payment when Mercado Pago reports it approved", async () => {
      // GIVEN Mercado Pago reports an approved payment referencing the pending booking
      mockPaymentClient.get.mockResolvedValue({
        id: 4242,
        status: "approved",
        external_reference: bookingId,
        transaction_amount: 30,
      });

      // WHEN the webhook notification arrives
      const response = await app.inject({
        method: "POST",
        url: "/payments/webhook",
        payload: { type: "payment", data: { id: "4242" } },
      });

      // THEN the booking is confirmed and the payment is persisted as approved
      expect(response.statusCode).toBe(200);
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
      expect(booking.status).toBe("confirmed");
      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, bookingId));
      expect(payment).toMatchObject({ externalPaymentId: "4242", status: "approved", amountCents: 3000 });
    });

    it("should not let a late notification for an older payment attempt overwrite an already-approved payment row", async () => {
      // GIVEN the booking was already confirmed by an approved payment
      mockPaymentClient.get.mockResolvedValue({
        id: 7001,
        status: "approved",
        external_reference: bookingId,
        transaction_amount: 30,
      });
      await app.inject({ method: "POST", url: "/payments/webhook", payload: { type: "payment", data: { id: "7001" } } });

      // WHEN a late notification for a different (earlier, rejected) payment attempt on the same booking arrives
      mockPaymentClient.get.mockResolvedValue({
        id: 7000,
        status: "rejected",
        external_reference: bookingId,
        transaction_amount: 30,
      });
      await app.inject({ method: "POST", url: "/payments/webhook", payload: { type: "payment", data: { id: "7000" } } });

      // THEN the payments row still reflects the approved payment, not the stale rejected one
      const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, bookingId));
      expect(payment).toMatchObject({ externalPaymentId: "7001", status: "approved" });
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
      expect(booking.status).toBe("confirmed");
    });

    it("should stay idempotent when the same approved notification is redelivered", async () => {
      // GIVEN the booking was already confirmed by a first approved notification
      mockPaymentClient.get.mockResolvedValue({
        id: 4243,
        status: "approved",
        external_reference: bookingId,
        transaction_amount: 30,
      });
      await app.inject({ method: "POST", url: "/payments/webhook", payload: { type: "payment", data: { id: "4243" } } });

      // WHEN the same notification is delivered again
      const response = await app.inject({
        method: "POST",
        url: "/payments/webhook",
        payload: { type: "payment", data: { id: "4243" } },
      });

      // THEN it still answers 200 and the booking stays confirmed
      expect(response.statusCode).toBe(200);
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
      expect(booking.status).toBe("confirmed");
    });

    it("should confirm the booking from the Preferences API's legacy ?topic=payment&id=... IPN, with no JSON body", async () => {
      // GIVEN Mercado Pago reports an approved payment, notified in the legacy query-param-only IPN shape
      mockPaymentClient.get.mockResolvedValue({
        id: 5555,
        status: "approved",
        external_reference: bookingId,
        transaction_amount: 30,
      });

      // WHEN the IPN notification arrives as query params with no body
      const response = await app.inject({ method: "POST", url: "/payments/webhook?id=5555&topic=payment" });

      // THEN the booking is confirmed just like with the v2 body shape
      expect(response.statusCode).toBe(200);
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
      expect(booking.status).toBe("confirmed");
    });

    it("should cancel the booking and free the seat for rebooking when the payment is rejected", async () => {
      // GIVEN Mercado Pago reports a rejected payment for the booking
      mockPaymentClient.get.mockResolvedValue({
        id: 4244,
        status: "rejected",
        external_reference: bookingId,
        transaction_amount: 30,
      });

      // WHEN the webhook notification arrives
      await app.inject({ method: "POST", url: "/payments/webhook", payload: { type: "payment", data: { id: "4244" } } });

      // THEN the booking is cancelled, its seat row is gone, and the seat can be booked again
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
      expect(booking.status).toBe("cancelled");
      const seats = await db.select().from(schema.bookingSeats).where(eq(schema.bookingSeats.bookingId, bookingId));
      expect(seats).toHaveLength(0);

      const [retry] = await db
        .insert(schema.bookings)
        .values({ userId, sessionId, status: "pending" })
        .returning({ id: schema.bookings.id });
      await expect(
        db.insert(schema.bookingSeats).values({ bookingId: retry.id, sessionId, seatId, ticketType: "full", priceCents: 3000 }),
      ).resolves.not.toThrow();
    });

    it("should ignore notifications that are not payment events", async () => {
      // GIVEN a merchant_order notification

      // WHEN it arrives at the webhook
      const response = await app.inject({
        method: "POST",
        url: "/payments/webhook",
        payload: { type: "merchant_order", data: { id: "1" } },
      });

      // THEN it answers 200 without touching Mercado Pago or the booking
      expect(response.statusCode).toBe(200);
      expect(mockPaymentClient.get).not.toHaveBeenCalled();
    });
  });
});
