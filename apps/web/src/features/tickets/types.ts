export interface TicketSeat {
  rowLabel: string;
  seatNumber: number;
}

export interface Ticket {
  bookingId: string;
  status: string;
  session: {
    id: string;
    startsAt: string;
    priceCents: number;
    movie: { title: string };
    room: { name: string };
    cinema: { name: string; city: string };
  };
  seats: TicketSeat[];
}
