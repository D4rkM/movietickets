import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Transporter } from "nodemailer";
import { MAIL_TRANSPORT } from "./mail-transport.provider";

export interface BookingConfirmationSeat {
  rowLabel: string;
  seatNumber: number;
}

export interface BookingConfirmationEmail {
  to: string;
  bookingId: string;
  movieTitle: string;
  cinemaName: string;
  roomName: string;
  startsAt: Date;
  seats: BookingConfirmationSeat[];
  totalCents: number;
}

const CENTS_PER_UNIT = 100;

function formatSeat(seat: BookingConfirmationSeat): string {
  return `${seat.rowLabel}${seat.seatNumber}`;
}

function formatPriceBRL(cents: number): string {
  return (cents / CENTS_PER_UNIT).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

@Injectable()
export class NotificationService {
  private readonly from: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: Transporter,
    config: ConfigService,
  ) {
    this.from = config.get<string>("MAIL_FROM", "MovieTickets <no-reply@movietickets.local>");
  }

  async sendBookingConfirmationEmail(booking: BookingConfirmationEmail): Promise<void> {
    const seatList = booking.seats.map(formatSeat).join(", ");

    await this.transport.sendMail({
      from: this.from,
      to: booking.to,
      subject: `Ingresso confirmado: ${booking.movieTitle}`,
      text: [
        `Sua reserva #${booking.bookingId} foi confirmada.`,
        `Filme: ${booking.movieTitle}`,
        `Local: ${booking.cinemaName} - ${booking.roomName}`,
        `Sessão: ${booking.startsAt.toLocaleString("pt-BR")}`,
        `Assentos: ${seatList}`,
        `Total: ${formatPriceBRL(booking.totalCents)}`,
      ].join("\n"),
    });
  }
}
