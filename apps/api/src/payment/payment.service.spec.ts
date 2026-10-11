import { ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { BookingService } from "../booking/booking.service";
import { DRIZZLE } from "../db/drizzle.module";
import { PAYMENT_CLIENT, PREFERENCE_CLIENT } from "./mercadopago.providers";
import { PaymentService } from "./payment.service";

describe("PaymentService", () => {
  const mockDb = {
    query: { bookings: { findFirst: jest.fn() } },
    insert: jest.fn(),
  };
  const mockPreferenceClient = { create: jest.fn() };
  const mockPaymentClient = { get: jest.fn() };
  const mockBookingService = { confirmPaidBooking: jest.fn() };
  const mockConfig = { get: jest.fn((_key: string, fallback: string) => fallback) };

  let service: PaymentService;
  let onConflictDoUpdate: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    mockDb.insert.mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate }) });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PREFERENCE_CLIENT, useValue: mockPreferenceClient },
        { provide: PAYMENT_CLIENT, useValue: mockPaymentClient },
        { provide: BookingService, useValue: mockBookingService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  describe("createCheckout", () => {
    const pendingBooking = {
      id: "booking-1",
      userId: "user-1",
      status: "pending",
      session: { movie: { title: "Dune" } },
      seats: [
        { seatId: "seat-1", priceCents: 3000, seat: { rowLabel: "A", seatNumber: 1 } },
        { seatId: "seat-2", priceCents: 1500, seat: { rowLabel: "A", seatNumber: 2 } },
      ],
    };

    it("should create a preference with one item per seat and return its init_point", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue(pendingBooking);
      mockPreferenceClient.create.mockResolvedValue({ init_point: "https://mp.test/checkout/abc" });

      // ACT
      const result = await service.createCheckout("booking-1", "user-1");

      // ASSERT
      expect(result).toEqual({ checkoutUrl: "https://mp.test/checkout/abc" });
      const body = mockPreferenceClient.create.mock.calls[0][0].body;
      expect(body.external_reference).toBe("booking-1");
      expect(body.items).toEqual([
        { id: "seat-1", title: "Dune - A1", quantity: 1, currency_id: "BRL", unit_price: 30 },
        { id: "seat-2", title: "Dune - A2", quantity: 1, currency_id: "BRL", unit_price: 15 },
      ]);
    });

    it("should point the webhook notification at the public API url", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue(pendingBooking);
      mockPreferenceClient.create.mockResolvedValue({ init_point: "https://mp.test/checkout/abc" });

      // ACT
      await service.createCheckout("booking-1", "user-1");

      // ASSERT
      const body = mockPreferenceClient.create.mock.calls[0][0].body;
      expect(body.notification_url).toBe("http://localhost:3000/payments/webhook");
    });

    it("should omit auto_return when WEB_URL is a plain http dev url, since Mercado Pago rejects it", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue(pendingBooking);
      mockPreferenceClient.create.mockResolvedValue({ init_point: "https://mp.test/checkout/abc" });

      // ACT
      await service.createCheckout("booking-1", "user-1");

      // ASSERT
      const body = mockPreferenceClient.create.mock.calls[0][0].body;
      expect(body.auto_return).toBeUndefined();
      expect(body.back_urls.success).toBe("http://localhost:5173/checkout/retorno");
    });

    it("should include auto_return when WEB_URL is https", async () => {
      // ARRANGE — WEB_URL has to be https *before* construction, since the service reads it once in its constructor
      mockDb.query.bookings.findFirst.mockResolvedValue(pendingBooking);
      mockPreferenceClient.create.mockResolvedValue({ init_point: "https://mp.test/checkout/abc" });
      const httpsConfig = { get: jest.fn((key: string) => (key === "WEB_URL" ? "https://movietickets.app" : "http://localhost:3000")) };
      const moduleRef = await Test.createTestingModule({
        providers: [
          PaymentService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: PREFERENCE_CLIENT, useValue: mockPreferenceClient },
          { provide: PAYMENT_CLIENT, useValue: mockPaymentClient },
          { provide: BookingService, useValue: mockBookingService },
          { provide: ConfigService, useValue: httpsConfig },
        ],
      }).compile();
      const httpsService = moduleRef.get(PaymentService);

      // ACT
      await httpsService.createCheckout("booking-1", "user-1");

      // ASSERT
      const body = mockPreferenceClient.create.mock.calls[0][0].body;
      expect(body.auto_return).toBe("approved");
      expect(body.back_urls.success).toBe("https://movietickets.app/checkout/retorno");
    });

    it("should throw NotFound when the booking belongs to another user", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue({ ...pendingBooking, userId: "someone-else" });

      // ACT
      const promise = service.createCheckout("booking-1", "user-1");

      // ASSERT
      await expect(promise).rejects.toThrow(NotFoundException);
      expect(mockPreferenceClient.create).not.toHaveBeenCalled();
    });

    it("should throw Conflict when the booking is no longer pending", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue({ ...pendingBooking, status: "confirmed" });

      // ACT
      const promise = service.createCheckout("booking-1", "user-1");

      // ASSERT
      await expect(promise).rejects.toThrow(ConflictException);
      expect(mockPreferenceClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handleWebhook", () => {
    it("should ignore notifications that are not payment events", async () => {
      // ARRANGE
      const notification = { type: "merchant_order", data: { id: "1" } };

      // ACT
      await service.handleWebhook(notification);

      // ASSERT
      expect(mockPaymentClient.get).not.toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });

    it("should handle the Preferences API's legacy IPN body shape (topic/resource)", async () => {
      // ARRANGE — Checkout Pro via Preferences sends this instead of the v2 {type,data} shape
      mockPaymentClient.get.mockResolvedValue({
        id: 183574424580,
        status: "approved",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ topic: "payment", resource: "183574424580" });

      // ASSERT
      expect(mockPaymentClient.get).toHaveBeenCalledWith({ id: 183574424580 });
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith("booking-1");
    });

    it("should handle the legacy IPN sent only as query params, with no usable body", async () => {
      // ARRANGE — oldest Preferences API notifications carry no JSON body at all
      mockPaymentClient.get.mockResolvedValue({
        id: 183574424580,
        status: "approved",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({}, { topic: "payment", id: "183574424580" });

      // ASSERT
      expect(mockPaymentClient.get).toHaveBeenCalledWith({ id: 183574424580 });
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith("booking-1");
    });

    it("should not throw when Mercado Pago sends no JSON body at all", async () => {
      // ARRANGE — a legacy IPN with no body parses to `undefined`, not `{}`
      // ACT
      await service.handleWebhook(undefined, { topic: "merchant_order", id: "1" });

      // ASSERT
      expect(mockPaymentClient.get).not.toHaveBeenCalled();
    });

    it("should ignore a merchant_order IPN even when it carries a resource id", async () => {
      // ARRANGE
      // ACT
      await service.handleWebhook({ topic: "merchant_order", resource: "45161808137" });

      // ASSERT
      expect(mockPaymentClient.get).not.toHaveBeenCalled();
    });

    it("should confirm the booking when the re-fetched payment is approved", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 999,
        status: "approved",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "999" } });

      // ASSERT
      expect(mockPaymentClient.get).toHaveBeenCalledWith({ id: 999 });
      expect(onConflictDoUpdate).toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith("booking-1");
    });

    it("should record a non-approved payment without confirming the booking", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 1000,
        status: "rejected",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "1000" } });

      // ASSERT
      expect(onConflictDoUpdate).toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });

    it("should skip payments without an external reference", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({ id: 1, status: "approved", transaction_amount: 10 });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "1" } });

      // ASSERT
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });
  });
});
