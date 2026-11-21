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

export interface RefundRequestedEmail {
  to: string;
  bookingId: string;
  movieTitle: string;
  cinemaName: string;
  roomName: string;
  startsAt: Date;
  /** Seat labels such as "A1", from the cancellation snapshot. */
  seatLabels: string[];
  amountCents: number;
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

  async sendRefundRequestedEmail(refund: RefundRequestedEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: refund.to,
      subject: `Estorno solicitado: ${refund.movieTitle}`,
      text: [
        `O estorno da sua reserva #${refund.bookingId} foi solicitado.`,
        `Filme: ${refund.movieTitle}`,
        `Local: ${refund.cinemaName} - ${refund.roomName}`,
        `Sessão: ${refund.startsAt.toLocaleString("pt-BR")}`,
        `Assentos: ${refund.seatLabels.join(", ")}`,
        `Valor estornado: ${formatPriceBRL(refund.amountCents)}`,
        "O valor volta na fatura do cartão conforme o prazo do seu banco.",
      ].join("\n"),
    });
  }
}
