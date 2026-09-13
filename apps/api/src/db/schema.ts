import { relations } from "drizzle-orm";
import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("customer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const movies = pgTable("movies", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  synopsis: text("synopsis"),
  durationMinutes: integer("duration_minutes").notNull(),
  posterUrl: text("poster_url"),
  rating: text("rating"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cinemas = pgTable("cinemas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cinemaId: uuid("cinema_id")
      .notNull()
      .references(() => cinemas.id),
    name: text("name").notNull(),
    rows: integer("rows").notNull(),
    seatsPerRow: integer("seats_per_row").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.cinemaId, table.name)],
);

export const seats = pgTable(
  "seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    rowLabel: text("row_label").notNull(),
    seatNumber: integer("seat_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.roomId, table.rowLabel, table.seatNumber)],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  movieId: uuid("movie_id")
    .notNull()
    .references(() => movies.id),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  priceCents: integer("price_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookingSeats = pgTable(
  "booking_seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => seats.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.sessionId, table.seatId)],
);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id")
    .notNull()
    .unique()
    .references(() => bookings.id),
  provider: text("provider").notNull().default("mercado_pago"),
  externalPaymentId: text("external_payment_id"),
  status: text("status").notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  cinema: one(cinemas, { fields: [rooms.cinemaId], references: [cinemas.id] }),
  seats: many(seats),
}));

export const seatsRelations = relations(seats, ({ one }) => ({
  room: one(rooms, { fields: [seats.roomId], references: [rooms.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  movie: one(movies, { fields: [sessions.movieId], references: [movies.id] }),
  room: one(rooms, { fields: [sessions.roomId], references: [rooms.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  user: one(users, { fields: [bookings.userId], references: [users.id] }),
  session: one(sessions, { fields: [bookings.sessionId], references: [sessions.id] }),
  seats: many(bookingSeats),
}));

export const bookingSeatsRelations = relations(bookingSeats, ({ one }) => ({
  booking: one(bookings, { fields: [bookingSeats.bookingId], references: [bookings.id] }),
  session: one(sessions, { fields: [bookingSeats.sessionId], references: [sessions.id] }),
  seat: one(seats, { fields: [bookingSeats.seatId], references: [seats.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Movie = typeof movies.$inferSelect;
export type NewMovie = typeof movies.$inferInsert;

export type Cinema = typeof cinemas.$inferSelect;
export type NewCinema = typeof cinemas.$inferInsert;

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

export type Seat = typeof seats.$inferSelect;
export type NewSeat = typeof seats.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;

export type BookingSeat = typeof bookingSeats.$inferSelect;
export type NewBookingSeat = typeof bookingSeats.$inferInsert;

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
