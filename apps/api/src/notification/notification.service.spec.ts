import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { MAIL_TRANSPORT } from "./mail-transport.provider";
import { NotificationService } from "./notification.service";

describe("NotificationService", () => {
  const mockTransport = { sendMail: jest.fn() };
  const mockConfig = { get: jest.fn((_key: string, fallback: string) => fallback) };

  let service: NotificationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: MAIL_TRANSPORT, useValue: mockTransport },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = moduleRef.get(NotificationService);
  });

  describe("sendBookingConfirmationEmail", () => {
    const booking = {
      to: "user@example.com",
      bookingId: "booking-1",
      movieTitle: "Dune",
      cinemaName: "Cine Centro",
      roomName: "Sala 3",
      startsAt: new Date("2026-10-20T20:00:00Z"),
      seats: [
        { rowLabel: "A", seatNumber: 1 },
        { rowLabel: "A", seatNumber: 2 },
      ],
      totalCents: 4500,
    };

    it("should send the email to the booking owner with the configured from address", async () => {
      // ARRANGE
      mockConfig.get.mockReturnValue("MovieTickets <no-reply@movietickets.local>");

      // ACT
      await service.sendBookingConfirmationEmail(booking);

      // ASSERT
      expect(mockTransport.sendMail).toHaveBeenCalledTimes(1);
      const message = mockTransport.sendMail.mock.calls[0][0];
      expect(message.to).toBe("user@example.com");
      expect(message.from).toBe("MovieTickets <no-reply@movietickets.local>");
    });

    it("should include the movie title, seats and total price in the email body", async () => {
      // ACT
      await service.sendBookingConfirmationEmail(booking);

      // ASSERT
      const message = mockTransport.sendMail.mock.calls[0][0];
      expect(message.subject).toContain("Dune");
      expect(message.text).toContain("A1, A2");
      expect(message.text).toContain("R$"); // pt-BR currency formatting
    });
  });
});
