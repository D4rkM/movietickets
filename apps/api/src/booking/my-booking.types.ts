export interface MyBookingSeat {
  rowLabel: string;
  seatNumber: number;
}

export interface MyBooking {
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
  seats: MyBookingSeat[];
}
