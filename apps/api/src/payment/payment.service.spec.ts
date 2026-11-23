import { FastifyRequest } from "fastify";
import { Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
  BookingExpiredException,
  BookingNotPendingException,
} from "../booking/booking-expired.exception";
import { BookingService } from "../booking/booking.service";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { PAYMENT_CLIENT } from "../mercadopago/mercadopago.providers";
import { PaymentController } from "./payment.controller";
import {
  AttemptIdConflictException,
  PaymentInProgressException,
  PaymentProviderTimeoutException,
  PaymentRequestInvalidException,
} from "./payment.exceptions";
import {
  buildPaymentEventPayload,
  buildPaymentRequest,
  canTransitionPaymentStatus,
  paymentStatusMessage,
} from "./payment.helpers";
import { RefundService } from "../refund/refund.service";
import { PaymentService } from "./payment.service";
import { createMockBusinessMetrics } from "../../test/helpers/business-metrics-mock";
import { BusinessMetrics } from "../telemetry/business-metrics";

const mockMetrics = createMockBusinessMetrics();

describe("PaymentService & payment helpers", () => {
  const mockDb = {
    query: { bookings: { findFirst: jest.fn() } },
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  };
  const mockPaymentClient = { create: jest.fn(), get: jest.fn() };
  const mockBookingService = { confirmPaidBooking: jest.fn() };
  const mockRefundService = { applyRefundedPayment: jest.fn() };
  const mockConfig = { get: jest.fn((_key: string, fallback: string) => fallback) };

  let service: PaymentService;
  let onConflictDoUpdate: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockBookingService.confirmPaidBooking.mockResolvedValue({
      confirmed: true,
      notify: jest.fn().mockResolvedValue(undefined),
    });

    const returning = jest.fn().mockResolvedValue([{ id: "payment-row-1" }]);
    onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoUpdate }),
    });
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });
    // Awaitable as-is, or with `.returning()` (one changed row).
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([{ id: "attempt-1" }]),
          }),
        ),
      }),
    });
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) =>
      callback(mockDb),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PAYMENT_CLIENT, useValue: mockPaymentClient },
        { provide: BookingService, useValue: mockBookingService },
        { provide: RefundService, useValue: mockRefundService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: BusinessMetrics, useValue: mockMetrics },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  describe("buildPaymentRequest (AC11)", () => {
    it("should build the Payment.create body and idempotencyKey from the server booking total and DTO", () => {
      // ARRANGE
      const dto: CreatePaymentDto = {
        attemptId: "11111111-1111-4111-8111-111111111111",
        token: "card-token-123",
        paymentMethodId: "visa",
        issuerId: "25",
        installments: 2,
        payer: {
          email: "buyer@example.com",
          identification: { type: "CPF", number: "12345678909" },
        },
      };

      // ACT
      const request = buildPaymentRequest({
        booking: {
          id: "booking-1",
          amountCents: 4500,
          description: "Dune - A1, A2",
        },
        dto,
        publicApiUrl: "https://api.movietickets.test",
      });

      // ASSERT
      expect(request).toEqual({
        body: {
          token: "card-token-123",
          transaction_amount: 45,
          installments: 2,
          payment_method_id: "visa",
          issuer_id: 25,
          payer: {
            email: "buyer@example.com",
            identification: { type: "CPF", number: "12345678909" },
          },
          external_reference: "booking-1",
          notification_url: "https://api.movietickets.test/payments/webhook",
          description: "Dune - A1, A2",
          metadata: { attempt_id: "11111111-1111-4111-8111-111111111111" },
        },
        requestOptions: {
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          timeout: 15_000,
        },
      });
    });

    it("should leave issuer_id undefined when issuerId is omitted", () => {
      // ARRANGE
      const dto: CreatePaymentDto = {
        attemptId: "11111111-1111-4111-8111-111111111111",
        token: "card-token-123",
        paymentMethodId: "master",
        installments: 1,
        payer: {
          email: "buyer@example.com",
          identification: { type: "CPF", number: "12345678909" },
        },
      };

      // ACT
      const request = buildPaymentRequest({
        booking: { id: "booking-1", amountCents: 3000, description: "Dune - A1" },
        dto,
        publicApiUrl: "http://localhost:3000",
      });

      // ASSERT
      expect(request.body.issuer_id).toBeUndefined();
    });
  });

  describe("paymentStatusMessage (AC18)", () => {
    it.each([
      ["approved", "accredited", "Pagamento aprovado!"],
      [
        "in_process",
        "pending_contingency",
        "Pagamento em análise. Você recebe a confirmação por e-mail.",
      ],
      [
        "in_process",
        "pending_review_manual",
        "Pagamento em análise. Você recebe a confirmação por e-mail.",
      ],
      [
        "in_process",
        "offline_process",
        "Pagamento em análise. Você recebe a confirmação por e-mail.",
      ],
      [
        "pending",
        "deferred_retry",
        "Pagamento em análise. Você recebe a confirmação por e-mail.",
      ],
      [
        "rejected",
        "cc_rejected_bad_filled_card_number",
        "Confira o número do cartão.",
      ],
      [
        "rejected",
        "cc_rejected_bad_filled_date",
        "Confira a data de validade.",
      ],
      [
        "rejected",
        "cc_rejected_bad_filled_security_code",
        "Confira o código de segurança.",
      ],
      [
        "rejected",
        "cc_rejected_bad_filled_other",
        "Confira os dados do cartão.",
      ],
      [
        "rejected",
        "cc_rejected_insufficient_amount",
        "Saldo ou limite insuficiente. Use outro cartão.",
      ],
      [
        "rejected",
        "cc_rejected_invalid_installments",
        "Esse cartão não aceita esse número de parcelas.",
      ],
      [
        "rejected",
        "cc_rejected_call_for_authorize",
        "Autorize o pagamento com o banco emissor e tente de novo.",
      ],
      [
        "rejected",
        "cc_rejected_card_disabled",
        "Cartão desabilitado. Ligue para o banco emissor ou use outro cartão.",
      ],
      [
        "rejected",
        "cc_rejected_duplicated_payment",
        "Você já fez um pagamento com esse valor. Use outro cartão se precisar pagar de novo.",
      ],
      [
        "rejected",
        "cc_rejected_max_attempts",
        "Limite de tentativas atingido. Use outro cartão.",
      ],
      ["rejected", "cc_rejected_high_risk", "Pagamento recusado. Use outro cartão."],
      ["rejected", "rejected_high_risk", "Pagamento recusado. Use outro cartão."],
      [
        "rejected",
        "cc_rejected_other_reason",
        "Pagamento recusado. Confira os dados ou use outro cartão.",
      ],
      [
        "cancelled",
        "expired",
        "Pagamento recusado. Confira os dados ou use outro cartão.",
      ],
      [
        "unknown_status",
        "unknown_detail",
        "Não foi possível concluir o pagamento. Tente de novo.",
      ],
    ])(
      "should map status %s with detail %s to %s",
      (status, statusDetail, expectedMessage) => {
        // ARRANGE & ACT
        const message = paymentStatusMessage(status, statusDetail);

        // ASSERT
        expect(message).toBe(expectedMessage);
      },
    );
  });

  describe("buildPaymentEventPayload (AC30)", () => {
    it("should copy only whitelisted keys and discard token, CPF, email and cardholder name", () => {
      // ARRANGE
      const rawInput = {
        attempt_id: "attempt-1",
        mp_payment_id: "999",
        status: "approved",
        status_detail: "accredited",
        amount_cents: 3000,
        installments: 1,
        payment_method_id: "visa",
        source: "sync" as const,
        error_code: null,
        token: "secret-card-token",
        cpf: "12345678909",
        identificationNumber: "12345678909",
        email: "buyer@example.com",
        cardholderName: "Maria Silva",
        payer: { email: "buyer@example.com", identification: { number: "12345678909" } },
      };

      // ACT
      const payload = buildPaymentEventPayload(rawInput);

      // ASSERT
      expect(payload).toEqual({
        attempt_id: "attempt-1",
        mp_payment_id: "999",
        status: "approved",
        status_detail: "accredited",
        amount_cents: 3000,
        installments: 1,
        payment_method_id: "visa",
        source: "sync",
        error_code: null,
      });
      expect(payload).not.toHaveProperty("token");
      expect(payload).not.toHaveProperty("cpf");
      expect(payload).not.toHaveProperty("identificationNumber");
      expect(payload).not.toHaveProperty("email");
      expect(payload).not.toHaveProperty("cardholderName");
      expect(payload).not.toHaveProperty("payer");
    });

    // Refund spec (docs/flows/refund/spec.md) AC25
    it("should keep the refund keys and the admin source while discarding customer and admin personal data", () => {
      // ARRANGE
      const rawInput = {
        attempt_id: "attempt-1",
        amount_cents: 5000,
        source: "admin" as const,
        refund_id: "refund-1",
        mp_refund_id: "777",
        refund_status: "approved",
        reason: "expired_booking_review",
        email: "cliente@example.com",
        adminEmail: "admin@example.com",
        name: "Maria Silva",
        cpf: "12345678909",
        requested_by: "admin-user-id",
      };

      // ACT
      const payload = buildPaymentEventPayload(rawInput);

      // ASSERT
      expect(payload).toEqual({
        attempt_id: "attempt-1",
        amount_cents: 5000,
        source: "admin",
        refund_id: "refund-1",
        mp_refund_id: "777",
        refund_status: "approved",
        reason: "expired_booking_review",
      });
    });
  });

  describe("canTransitionPaymentStatus (per-row regression guard)", () => {
    it.each([
      ["approved", "pending", false],
      ["approved", "in_process", false],
      ["approved", "authorized", false],
      ["approved", "rejected", false],
      ["approved", "cancelled", false],
      ["approved", "approved", true],
      ["approved", "refunded", true],
      ["approved", "charged_back", true],
      ["approved", "in_mediation", true],
      ["in_process", "approved", true],
      ["in_process", "rejected", true],
      ["pending", "cancelled", true],
      ["created", "approved", true],
    ])(
      "should return %s when transitioning a row from %s to %s",
      (currentStatus, nextStatus, allowed) => {
        // ARRANGE & ACT
        const result = canTransitionPaymentStatus(currentStatus, nextStatus);

        // ASSERT
        expect(result).toBe(allowed);
      },
    );
  });

  describe("applyPaymentStatus", () => {
    it("should confirm the booking and record booking_confirmed when status is approved", async () => {
      // ARRANGE
      const insertValues = jest.fn().mockResolvedValue(undefined);
      const tx = {
        insert: jest.fn().mockReturnValue({ values: insertValues }),
        update: jest.fn(),
      };
      const notifySpy = jest.fn().mockResolvedValue(undefined);
      mockBookingService.confirmPaidBooking.mockResolvedValue({
        confirmed: true,
        notify: notifySpy,
      });

      // ACT
      const notify = await service.applyPaymentStatus(
        tx as never,
        "booking-1",
        {
          id: "attempt-1",
          externalPaymentId: "4242",
          status: "approved",
          statusDetail: "accredited",
          amountCents: 3000,
          installments: 1,
          paymentMethodId: "visa",
        },
        "sync",
      );

      // ASSERT
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith(
        "booking-1",
        { externalPaymentId: "4242", amountCents: 3000 },
        tx,
        "payment_sync",
      );
      expect(tx.insert).toHaveBeenCalledWith(schema.paymentEvents);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-1",
          paymentId: "attempt-1",
          type: "booking_confirmed",
        }),
      );
      expect(notify).toBe(notifySpy);
    });

    it.each(["rejected", "cancelled", "in_process", "pending"])(
      "should keep the booking untouched without logging a warning when status is %s",
      async (status) => {
        // ARRANGE
        const tx = { insert: jest.fn(), update: jest.fn() };
        const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

        // ACT
        await service.applyPaymentStatus(
          tx as never,
          "booking-1",
          { id: "attempt-1", externalPaymentId: "4242", status, amountCents: 3000 },
          "webhook",
        );

        // ASSERT
        expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
        expect(tx.insert).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      },
    );

    it.each(["authorized", "charged_back", "in_mediation", "unknown"])(
      "should keep the booking untouched and log a warning when status is %s",
      async (status) => {
        // ARRANGE
        const tx = { insert: jest.fn(), update: jest.fn() };
        const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

        // ACT
        await service.applyPaymentStatus(
          tx as never,
          "booking-1",
          { id: "attempt-1", externalPaymentId: "4242", status, amountCents: 3000 },
          "webhook",
        );

        // ASSERT
        expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
        expect(tx.insert).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"${status}"`));
        warnSpy.mockRestore();
      },
    );

    // Refund spec (docs/flows/refund/spec.md): refunded now has an effect
    it("should hand a refunded payment and its refunds over to RefundService", async () => {
      // ARRANGE
      const tx = { insert: jest.fn(), update: jest.fn() };
      const notify = jest.fn();
      mockRefundService.applyRefundedPayment.mockResolvedValue(notify);
      const refunds = [{ id: 777, status: "approved", amount: 30 }];

      // ACT
      const result = await service.applyPaymentStatus(
        tx as never,
        "booking-1",
        { id: "attempt-1", externalPaymentId: "4242", status: "refunded", amountCents: 3000, refunds },
        "webhook",
      );

      // ASSERT
      expect(mockRefundService.applyRefundedPayment).toHaveBeenCalledWith(tx, {
        bookingId: "booking-1",
        paymentId: "attempt-1",
        paymentStatus: "refunded",
        amountCents: 3000,
        refunds,
      });
      expect(result).toBe(notify);
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });

    it("should reconcile refunds of an approved payment instead of re-running the approval", async () => {
      // ARRANGE
      const tx = { insert: jest.fn(), update: jest.fn() };
      mockRefundService.applyRefundedPayment.mockResolvedValue(jest.fn());
      const refunds = [{ id: 777, status: "rejected" }];

      // ACT
      await service.applyPaymentStatus(
        tx as never,
        "booking-1",
        { id: "attempt-1", externalPaymentId: "4242", status: "approved", amountCents: 3000, refunds },
        "webhook",
      );

      // ASSERT
      expect(mockRefundService.applyRefundedPayment).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ paymentStatus: "approved", refunds }),
      );
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });

    it("should only log a warning for a partial refund made outside the API", async () => {
      // ARRANGE
      const tx = { insert: jest.fn(), update: jest.fn() };
      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      // ACT
      await service.applyPaymentStatus(
        tx as never,
        "booking-1",
        {
          id: "attempt-1",
          externalPaymentId: "4242",
          status: "approved",
          statusDetail: "partially_refunded",
          amountCents: 3000,
          refunds: [{ id: 1, status: "approved", amount: 10 }],
        },
        "webhook",
      );

      // ASSERT
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Partial refund"));
      expect(mockRefundService.applyRefundedPayment).not.toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("getPaymentSummary", () => {
    const pendingBooking = {
      id: "booking-1",
      userId: "user-1",
      status: "pending",
      expiresAt: new Date("2026-11-08T18:10:00.000Z"),
      pastDeadline: false,
      session: { movie: { title: "Dune" } },
      seats: [
        { seatId: "seat-1", ticketType: "full", priceCents: 3000, seat: { rowLabel: "A", seatNumber: 1 } },
        { seatId: "seat-2", ticketType: "half", priceCents: 1500, seat: { rowLabel: "A", seatNumber: 2 } },
      ],
    };

    it("should return the booking summary with amountCents summed from booking_seats", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue(pendingBooking);

      // ACT
      const summary = await service.getPaymentSummary("booking-1", "user-1");

      // ASSERT
      expect(summary).toEqual({
        bookingId: "booking-1",
        status: "pending",
        expiresAt: "2026-11-08T18:10:00.000Z",
        amountCents: 4500,
        currency: "BRL",
        description: "Dune - A1, A2",
        seats: [
          { seatId: "seat-1", label: "A1", ticketType: "full", priceCents: 3000 },
          { seatId: "seat-2", label: "A2", ticketType: "half", priceCents: 1500 },
        ],
      });
    });

    it("should throw NotFound when the booking belongs to another user", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue({ ...pendingBooking, userId: "someone-else" });

      // ACT
      const promise = service.getPaymentSummary("booking-1", "user-1");

      // ASSERT
      await expect(promise).rejects.toThrow(NotFoundException);
    });

    it.each([
      { status: "expired", pastDeadline: false },
      { status: "pending", pastDeadline: true },
    ])(
      "should refuse payment summary as BOOKING_EXPIRED for status $status and pastDeadline $pastDeadline",
      async (state) => {
        // ARRANGE
        mockDb.query.bookings.findFirst.mockResolvedValue({ ...pendingBooking, ...state });

        // ACT
        const promise = service.getPaymentSummary("booking-1", "user-1");

        // ASSERT
        await expect(promise).rejects.toThrow(BookingExpiredException);
      },
    );

    it("should throw Conflict (BOOKING_NOT_PENDING) when the booking is no longer pending", async () => {
      // ARRANGE
      mockDb.query.bookings.findFirst.mockResolvedValue({ ...pendingBooking, status: "confirmed" });

      // ACT
      const promise = service.getPaymentSummary("booking-1", "user-1");

      // ASSERT
      await expect(promise).rejects.toThrow(BookingNotPendingException);
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
      // ARRANGE
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
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith(
        "booking-1",
        expect.anything(),
        expect.anything(),
        "payment_webhook",
      );
    });

    it("should handle the legacy IPN sent only as query params, with no usable body", async () => {
      // ARRANGE
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
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith(
        "booking-1",
        expect.anything(),
        expect.anything(),
        "payment_webhook",
      );
    });

    it("should not throw when Mercado Pago sends no JSON body at all", async () => {
      // ARRANGE & ACT
      await service.handleWebhook(undefined, { topic: "merchant_order", id: "1" });

      // ASSERT
      expect(mockPaymentClient.get).not.toHaveBeenCalled();
    });

    it("should ignore a merchant_order IPN even when it carries a resource id", async () => {
      // ARRANGE & ACT
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
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith(
        "booking-1",
        {
          externalPaymentId: "999",
          amountCents: 4500,
        },
        expect.anything(),
        "payment_webhook",
      );
    });

    it("should guard the payments upsert on external_payment_id so a later notification can't overwrite an approved row", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 999,
        status: "rejected",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "999" } });

      // ASSERT
      expect(onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          target: schema.payments.externalPaymentId,
          setWhere: expect.anything(),
        }),
      );
    });

    it("should keep the booking pending when the payment is rejected", async () => {
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

    it("should keep the booking pending when the payment is cancelled (expired)", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 1001,
        status: "cancelled",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "1001" } });

      // ASSERT
      expect(onConflictDoUpdate).toHaveBeenCalled();
      expect(mockBookingService.confirmPaidBooking).not.toHaveBeenCalled();
    });

    it("should not confirm the booking while the payment is still pending/in_process", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 1002,
        status: "in_process",
        external_reference: "booking-1",
        transaction_amount: 45,
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "1002" } });

      // ASSERT
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

    it("should update an existing attempt found by metadata.attempt_id without inserting a new row", async () => {
      // ARRANGE
      mockPaymentClient.get.mockResolvedValue({
        id: 5000,
        status: "approved",
        status_detail: "accredited",
        external_reference: "booking-1",
        transaction_amount: 30,
        installments: 1,
        payment_method_id: "visa",
        metadata: { attempt_id: "attempt-1" },
      });
      mockDb.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: "attempt-1", bookingId: "booking-1" }]),
        }),
      });
      const updateReturning = jest.fn().mockResolvedValue([{ id: "attempt-1" }]);
      mockDb.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: updateReturning }),
        }),
      });

      // ACT
      await service.handleWebhook({ type: "payment", data: { id: "5000" } });

      // ASSERT
      expect(mockDb.update).toHaveBeenCalledWith(schema.payments);
      expect(mockBookingService.confirmPaidBooking).toHaveBeenCalledWith(
        "booking-1",
        { externalPaymentId: "5000", amountCents: 3000 },
        expect.anything(),
        "payment_webhook",
      );
    });
    describe("metrics", () => {
      function stubAttemptFoundByExternalId(attempt: Record<string, unknown>) {
        mockDb.select.mockReturnValue({
          from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([attempt]) }),
        });
      }

      it("should count a webhook status change of an existing attempt", async () => {
        // ARRANGE
        stubAttemptFoundByExternalId({ id: "attempt-1", bookingId: "booking-1", status: "in_process" });
        mockPaymentClient.get.mockResolvedValue({ id: 4242, status: "rejected", external_reference: "booking-1" });

        // ACT
        await service.handleWebhook({ type: "payment", data: { id: "4242" } });

        // ASSERT
        expect(mockMetrics.paymentStatusChanged).toHaveBeenCalledWith("rejected", "webhook");
      });

      it("should not count a redelivered webhook with the same status", async () => {
        // ARRANGE
        stubAttemptFoundByExternalId({ id: "attempt-1", bookingId: "booking-1", status: "rejected" });
        mockPaymentClient.get.mockResolvedValue({ id: 4242, status: "rejected", external_reference: "booking-1" });

        // ACT
        await service.handleWebhook({ type: "payment", data: { id: "4242" } });

        // ASSERT
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalled();
      });

      it("should not count a late pre-approval status the guard refuses on an approved attempt", async () => {
        // ARRANGE
        stubAttemptFoundByExternalId({ id: "attempt-1", bookingId: "booking-1", status: "approved" });
        mockPaymentClient.get.mockResolvedValue({ id: 4242, status: "pending", external_reference: "booking-1" });

        // ACT
        await service.handleWebhook({ type: "payment", data: { id: "4242" } });

        // ASSERT
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalled();
      });

      it("should count a payment first seen by the webhook (inserted row)", async () => {
        // ARRANGE
        mockPaymentClient.get.mockResolvedValue({ id: 999, status: "approved", external_reference: "booking-1" });

        // ACT
        await service.handleWebhook({ type: "payment", data: { id: "999" } });

        // ASSERT
        expect(mockMetrics.paymentStatusChanged).toHaveBeenCalledWith("approved", "webhook");
      });

      it("should not count anything when the webhook transaction rolls back", async () => {
        // ARRANGE
        stubAttemptFoundByExternalId({ id: "attempt-1", bookingId: "booking-1", status: "in_process" });
        mockPaymentClient.get.mockResolvedValue({ id: 4242, status: "approved", external_reference: "booking-1" });
        mockBookingService.confirmPaidBooking.mockRejectedValue(new Error("deadlock"));

        // ACT
        const promise = service.handleWebhook({ type: "payment", data: { id: "4242" } });

        // ASSERT
        await expect(promise).rejects.toThrow("deadlock");
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalled();
      });
    });
  });

  describe("createPayment", () => {
    const validDto: CreatePaymentDto = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      token: "card-token",
      paymentMethodId: "visa",
      issuerId: "25",
      installments: 1,
      payer: {
        email: "buyer@example.com",
        identification: { type: "CPF", number: "12345678909" },
      },
    };

    const lockedPendingBooking = {
      id: "booking-1",
      userId: "user-1",
      sessionId: "session-1",
      status: "pending",
      expiresAt: new Date("2026-11-08T18:10:00.000Z"),
      pastDeadline: false,
    };

    const bookingDetails = {
      id: "booking-1",
      session: { movie: { title: "Dune" } },
      seats: [{ seatId: "seat-1", priceCents: 3000, seat: { rowLabel: "A", seatNumber: 1 } }],
    };

    function setupCreatePaymentTx(options: {
      lockedBooking?: typeof lockedPendingBooking | undefined;
      existingAttempt?: Record<string, unknown> | undefined;
      inProgress?: { id: string } | undefined;
      staleCreated?: { id: string; amountCents: number }[];
      finalBookingStatus?: string;
    }) {
      const {
        lockedBooking = lockedPendingBooking,
        existingAttempt = undefined,
        inProgress = undefined,
        staleCreated = [],
        finalBookingStatus = "confirmed",
      } = options;

      let selectCall = 0;
      mockDb.select.mockImplementation(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                for: jest.fn().mockResolvedValue(lockedBooking ? [lockedBooking] : []),
              }),
            }),
          };
        }
        if (selectCall === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue(existingAttempt ? [existingAttempt] : []),
            }),
          };
        }
        if (selectCall === 3) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(inProgress ? [inProgress] : []),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ status: finalBookingStatus }]),
          }),
        };
      });

      mockDb.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(staleCreated),
          }),
        }),
      });
      mockDb.query.bookings.findFirst.mockResolvedValue(bookingDetails);
    }

    it("should create a payment attempt, call Mercado Pago, and confirm the booking on approved", async () => {
      // ARRANGE
      setupCreatePaymentTx({ staleCreated: [{ id: "old-created", amountCents: 3000 }] });
      mockPaymentClient.create.mockResolvedValue({
        id: 7777,
        status: "approved",
        status_detail: "accredited",
        installments: 1,
        payment_method_id: "visa",
      });

      // ACT
      const result = await service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      expect(mockPaymentClient.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        attemptId: validDto.attemptId,
        paymentId: "7777",
        status: "approved",
        statusDetail: "accredited",
        message: "Pagamento aprovado!",
        bookingStatus: "confirmed",
      });
    });

    it("should replay the stored result without calling Mercado Pago when attemptId already resolved", async () => {
      // ARRANGE
      setupCreatePaymentTx({
        existingAttempt: {
          id: validDto.attemptId,
          bookingId: "booking-1",
          externalPaymentId: "8888",
          status: "rejected",
          statusDetail: "cc_rejected_bad_filled_security_code",
        },
      });

      // ACT
      const result = await service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      expect(mockPaymentClient.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        attemptId: validDto.attemptId,
        paymentId: "8888",
        status: "rejected",
        statusDetail: "cc_rejected_bad_filled_security_code",
        message: "Confira o código de segurança.",
        bookingStatus: "pending",
      });
    });

    it("should throw AttemptIdConflictException when attemptId belongs to another booking", async () => {
      // ARRANGE
      setupCreatePaymentTx({
        existingAttempt: {
          id: validDto.attemptId,
          bookingId: "other-booking",
          status: "approved",
        },
      });

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(AttemptIdConflictException);
    });

    it("should throw PaymentRequestInvalidException when replaying an attempt in request_failed status", async () => {
      // ARRANGE
      setupCreatePaymentTx({
        existingAttempt: {
          id: validDto.attemptId,
          bookingId: "booking-1",
          status: "request_failed",
        },
      });

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(PaymentRequestInvalidException);
    });

    it("should throw PaymentInProgressException when another attempt is in flight", async () => {
      // ARRANGE
      setupCreatePaymentTx({ inProgress: { id: "attempt-in-flight" } });

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(PaymentInProgressException);
    });

    it("should mark the attempt as request_failed and throw PaymentRequestInvalidException on MP 4xx", async () => {
      // ARRANGE
      setupCreatePaymentTx({});
      mockPaymentClient.create.mockRejectedValue(
        Object.assign(new Error("Invalid card token"), { status: 400, cause: [{ code: "E301" }] }),
      );

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(PaymentRequestInvalidException);
    });

    it("should throw PaymentInProgressException when Mercado Pago returns 409", async () => {
      // ARRANGE
      setupCreatePaymentTx({});
      mockPaymentClient.create.mockRejectedValue(
        Object.assign(new Error("Conflict in progress"), { status: 409 }),
      );

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(PaymentInProgressException);
    });

    it("should keep the attempt as created and throw PaymentProviderTimeoutException on MP 5xx or timeout", async () => {
      // ARRANGE
      setupCreatePaymentTx({});
      mockPaymentClient.create.mockRejectedValue(Object.assign(new Error("Gateway timeout"), { status: 504 }));

      // ACT
      const promise = service.createPayment("booking-1", "user-1", validDto);

      // ASSERT
      await expect(promise).rejects.toThrow(PaymentProviderTimeoutException);
    });
    describe("metrics", () => {
      /** update().set().where().returning() resolving to `rows`, one call each, in order. */
      function stubUpdateReturning(...rowsPerCall: unknown[][]) {
        for (const rows of rowsPerCall) {
          mockDb.update.mockReturnValueOnce({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }),
            }),
          });
        }
      }

      it("should count the new attempt, the abandoned ones and the synchronous status after each commit", async () => {
        // ARRANGE
        setupCreatePaymentTx({});
        stubUpdateReturning([{ id: "old-1", amountCents: 3000 }, { id: "old-2", amountCents: 3000 }], [{ id: "attempt-1" }]);
        mockPaymentClient.create.mockResolvedValue({ id: 7777, status: "rejected", status_detail: "cc_rejected_other_reason" });

        // ACT
        await service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        expect(mockMetrics.paymentAttemptCreated).toHaveBeenCalledTimes(1);
        expect(mockMetrics.paymentStatusChanged).toHaveBeenCalledWith("abandoned", "sync", 2);
        expect(mockMetrics.paymentStatusChanged).toHaveBeenCalledWith("rejected", "sync");
        expect(mockMetrics.paymentProviderError).not.toHaveBeenCalled();
      });

      it("should not count the synchronous status when the transition guard left the row untouched", async () => {
        // ARRANGE
        setupCreatePaymentTx({});
        stubUpdateReturning([], []);
        mockPaymentClient.create.mockResolvedValue({ id: 7777, status: "pending" });

        // ACT
        await service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalledWith("pending", "sync");
      });

      it("should not count anything from tx1 when it rolls back on a payment already in flight", async () => {
        // ARRANGE
        setupCreatePaymentTx({ inProgress: { id: "attempt-in-flight" } });
        stubUpdateReturning([{ id: "old-1", amountCents: 3000 }]);

        // ACT
        const promise = service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        await expect(promise).rejects.toThrow(PaymentInProgressException);
        expect(mockMetrics.paymentAttemptCreated).not.toHaveBeenCalled();
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalled();
      });

      it("should not count a new attempt when replaying a stored result", async () => {
        // ARRANGE
        setupCreatePaymentTx({
          existingAttempt: { id: validDto.attemptId, bookingId: "booking-1", externalPaymentId: "8888", status: "approved" },
        });

        // ACT
        await service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        expect(mockMetrics.paymentAttemptCreated).not.toHaveBeenCalled();
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalled();
      });

      it("should count request_failed and a request_invalid provider error on Mercado Pago 4xx", async () => {
        // ARRANGE
        setupCreatePaymentTx({});
        stubUpdateReturning([], [{ id: "attempt-1" }]);
        mockPaymentClient.create.mockRejectedValue(Object.assign(new Error("Invalid card token"), { status: 400 }));

        // ACT
        const promise = service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        await expect(promise).rejects.toThrow(PaymentRequestInvalidException);
        expect(mockMetrics.paymentStatusChanged).toHaveBeenCalledWith("request_failed", "sync", 1);
        expect(mockMetrics.paymentProviderError).toHaveBeenCalledWith("request_invalid");
      });

      it("should count a timeout provider error without any status change on Mercado Pago 5xx", async () => {
        // ARRANGE
        setupCreatePaymentTx({});
        mockPaymentClient.create.mockRejectedValue(Object.assign(new Error("Gateway timeout"), { status: 504 }));

        // ACT
        const promise = service.createPayment("booking-1", "user-1", validDto);

        // ASSERT
        await expect(promise).rejects.toThrow(PaymentProviderTimeoutException);
        expect(mockMetrics.paymentProviderError).toHaveBeenCalledWith("timeout");
        expect(mockMetrics.paymentStatusChanged).not.toHaveBeenCalledWith(expect.anything(), "sync");
      });
    });
  });

  describe("PaymentController", () => {
    it("should delegate getPaymentSummary, createPayment, and handleWebhook to PaymentService", async () => {
      // ARRANGE
      const mockService = {
        getPaymentSummary: jest.fn().mockResolvedValue({ bookingId: "booking-1" }),
        createPayment: jest.fn().mockResolvedValue({ attemptId: "attempt-1" }),
        handleWebhook: jest.fn().mockResolvedValue(undefined),
      };
      const controller = new PaymentController(mockService as unknown as PaymentService);
      const req = { user: { sub: "user-1", email: "buyer@example.com", role: "user" } } as FastifyRequest;
      const dto = { attemptId: "attempt-1" } as CreatePaymentDto;

      // ACT
      const summary = await controller.getPaymentSummary("booking-1", req);
      const payment = await controller.createPayment("booking-1", dto, req);
      await controller.handleWebhook({ type: "payment", data: { id: "1" } }, { id: "1" });

      // ASSERT
      expect(summary).toEqual({ bookingId: "booking-1" });
      expect(payment).toEqual({ attemptId: "attempt-1" });
      expect(mockService.getPaymentSummary).toHaveBeenCalledWith("booking-1", "user-1");
      expect(mockService.createPayment).toHaveBeenCalledWith("booking-1", "user-1", dto);
      expect(mockService.handleWebhook).toHaveBeenCalledWith(
        { type: "payment", data: { id: "1" } },
        { id: "1" },
      );
    });
  });
});
