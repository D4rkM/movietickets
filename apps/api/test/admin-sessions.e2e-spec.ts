import {
  AdminTestContext,
  bookedSeatPrices,
  catalogMovie,
  catalogSessionIds,
  countBookingsOfSession,
  countSessionsInRoom,
  createMovieAsAdmin,
  createRoomAsAdmin,
  createRoomWithMovie,
  createScheduledSession,
  createSessionAsAdmin,
  daysFromNow,
  deleteSessionAsAdmin,
  findSessionInDb,
  holdFirstSeatAsCustomer,
  insertAbandonedPendingBooking,
  insertBooking,
  insertSessionDirectly,
  plusMinutes,
  postSessionAsAdmin,
  seatMapStatuses,
  startAdminApp,
  updateSessionAsAdmin,
  warmUpConnectionPool,
} from "./helpers/admin";

describe("Painel admin: sessões (e2e)", () => {
  let ctx: AdminTestContext;
  const unknownId = "00000000-0000-4000-8000-000000000000";

  beforeAll(async () => {
    ctx = await startAdminApp("admin-sessions");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("AC12: deve criar sessão futura e devolver todos os assentos da sala como livres", async () => {
    // GIVEN a movie and a 3 × 4 room
    const { movie, room } = await createRoomWithMovie(ctx);

    // WHEN the admin creates a future session for them
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: "2030-12-20T19:00:00-03:00",
      priceCents: 3500,
    });

    // THEN it answers 201 with the time in UTC, and the seat map shows all 12 seats free
    expect(response.statusCode).toBe(201);
    const session = response.json();
    expect(session).toEqual(
      expect.objectContaining({
        startsAt: "2030-12-20T22:00:00.000Z",
        priceCents: 3500,
        movie: expect.objectContaining({ id: movie.id }),
        room: { id: room.id, name: room.name },
      }),
    );
    const statuses = await seatMapStatuses(ctx, session.id);
    expect(statuses).toHaveLength(12);
    expect(new Set(statuses)).toEqual(new Set(["free"]));
  });

  it("AC13: deve recusar com 400 sessão com início no passado", async () => {
    // GIVEN a movie and a room
    const { movie, room } = await createRoomWithMovie(ctx);

    // WHEN the admin creates a session that started an hour ago
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(new Date(), -60).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(0);
  });

  it("AC13: deve recusar com 400 sessão com preço 0", async () => {
    // GIVEN a movie and a room
    const { movie, room } = await createRoomWithMovie(ctx);

    // WHEN the admin creates a session priced at 0
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: daysFromNow(7).toISOString(),
      priceCents: 0,
    });

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(0);
  });

  it("AC13: deve recusar com 400 sessão sem horário de início", async () => {
    // GIVEN a movie and a room
    const { movie, room } = await createRoomWithMovie(ctx);

    // WHEN the admin creates a session without startsAt
    const response = await postSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, priceCents: 3000 });

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(0);
  });

  it("AC13: deve recusar com 404 sessão de filme inexistente", async () => {
    // GIVEN a room and a movie id that doesn't exist
    const room = await createRoomAsAdmin(ctx);

    // WHEN the admin creates a session for that movie
    const response = await postSessionAsAdmin(ctx, {
      movieId: unknownId,
      roomId: room.id,
      startsAt: daysFromNow(7).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 404
    expect(response.statusCode).toBe(404);
  });

  it("AC13: deve recusar com 404 sessão em sala inexistente", async () => {
    // GIVEN a movie and a room id that doesn't exist
    const movie = await createMovieAsAdmin(ctx);

    // WHEN the admin creates a session in that room
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: unknownId,
      startsAt: daysFromNow(7).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 404
    expect(response.statusCode).toBe(404);
  });

  it("AC14: deve recusar com 409 sessão que termina depois do início de outra na mesma sala", async () => {
    // GIVEN a 120-min session at 19:00
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 120 });
    const existingStart = daysFromNow(8, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: existingStart });

    // WHEN the admin schedules the same movie at 17:30 (would end at 19:30)
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(existingStart, -90).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 409
    expect(response.statusCode).toBe(409);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(1);
  });

  it("AC14: deve recusar com 409 sessão que começa antes do fim de outra na mesma sala", async () => {
    // GIVEN a 120-min session at 19:00 (ends at 21:00)
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 120 });
    const existingStart = daysFromNow(8, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: existingStart });

    // WHEN the admin schedules another session at 20:59
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(existingStart, 119).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 409
    expect(response.statusCode).toBe(409);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(1);
  });

  it("AC14: deve recusar com 409 sessão contida dentro de outra na mesma sala", async () => {
    // GIVEN a 180-min session at 19:00 and a 30-min short film
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 180 });
    const shortFilm = await createMovieAsAdmin(ctx, { durationMinutes: 30 });
    const existingStart = daysFromNow(8, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: existingStart });

    // WHEN the admin schedules the short film at 20:00, inside the long session
    const response = await postSessionAsAdmin(ctx, {
      movieId: shortFilm.id,
      roomId: room.id,
      startsAt: plusMinutes(existingStart, 60).toISOString(),
      priceCents: 3000,
    });

    // THEN it is refused with 409
    expect(response.statusCode).toBe(409);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(1);
  });

  it("AC14: deve aceitar sessão que começa exatamente no fim de outra na mesma sala", async () => {
    // GIVEN a 120-min session at 19:00 (ends at 21:00)
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 120 });
    const existingStart = daysFromNow(8, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: existingStart });

    // WHEN the admin schedules another session at exactly 21:00
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(existingStart, 120).toISOString(),
      priceCents: 3000,
    });

    // THEN it is created
    expect(response.statusCode).toBe(201);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(2);
  });

  it("AC14: deve aceitar sessão no mesmo horário em outra sala", async () => {
    // GIVEN a session at 19:00 in one room, and a second room
    const { movie, room } = await createRoomWithMovie(ctx);
    const startsAt = daysFromNow(8, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt });
    const otherRoom = await createRoomAsAdmin(ctx);

    // WHEN the admin schedules the same movie at 19:00 in the other room
    const response = await postSessionAsAdmin(ctx, {
      movieId: movie.id,
      roomId: otherRoom.id,
      startsAt: startsAt.toISOString(),
      priceCents: 3000,
    });

    // THEN it is created
    expect(response.statusCode).toBe(201);
  });

  it("AC14: deve recusar com 409 mudar o horário de uma sessão para cima de outra na mesma sala", async () => {
    // GIVEN two 120-min sessions in the same room, at 14:00 and 19:00
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 120 });
    const afternoon = await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(8, 14) });
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(8, 19) });

    // WHEN the admin moves the 14:00 session to 18:00
    const response = await updateSessionAsAdmin(ctx, afternoon.id, { startsAt: daysFromNow(8, 18).toISOString() });

    // THEN it is refused with 409 and the session keeps its time
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, afternoon.id))?.startsAt).toEqual(daysFromNow(8, 14));
  });

  it("AC15: deve gravar só uma de duas sessões sobrepostas criadas ao mesmo tempo na mesma sala", async () => {
    // GIVEN a movie, an empty room and enough open database connections for both requests to run at once
    const { movie, room } = await createRoomWithMovie(ctx, { durationMinutes: 120 });
    const startsAt = daysFromNow(9, 19);
    await warmUpConnectionPool(ctx);

    // WHEN two overlapping sessions are created in parallel
    const responses = await Promise.all([
      postSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: startsAt.toISOString(), priceCents: 3000 }),
      postSessionAsAdmin(ctx, {
        movieId: movie.id,
        roomId: room.id,
        startsAt: plusMinutes(startsAt, 30).toISOString(),
        priceCents: 3000,
      }),
    ]);

    // THEN exactly one is created (201), the other is refused (409), and the room has one session
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await countSessionsInRoom(ctx, room.id)).toBe(1);
  });

  it("AC16: deve aceitar mudar filme, sala, horário e preço de sessão sem atividade e refletir no catálogo", async () => {
    // GIVEN a future session without bookings or holds, plus another movie and room
    const { session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    const otherMovie = await createMovieAsAdmin(ctx);
    const otherRoom = await createRoomAsAdmin(ctx);
    const newStart = daysFromNow(11, 21);

    // WHEN the admin changes movie, room, time and price
    const response = await updateSessionAsAdmin(ctx, session.id, {
      movieId: otherMovie.id,
      roomId: otherRoom.id,
      startsAt: newStart.toISOString(),
      priceCents: 4200,
    });

    // THEN it is accepted and the catalog shows the session under the new movie, room, time and price
    expect(response.statusCode).toBe(200);
    const listed = await catalogMovie(ctx, otherMovie.id);
    expect(listed?.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        startsAt: newStart.toISOString(),
        priceCents: 4200,
        room: { id: otherRoom.id, name: otherRoom.name },
      }),
    ]);
  });

  it("AC16: deve recusar com 409 mudar o horário de sessão com reserva pendente", async () => {
    // GIVEN a future session with a pending booking
    const { room, session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    await insertBooking(ctx, session.id, room.id, "pending");

    // WHEN the admin moves it one hour later
    const response = await updateSessionAsAdmin(ctx, session.id, { startsAt: daysFromNow(10, 20).toISOString() });

    // THEN it is refused with 409 and the time stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, session.id))?.startsAt).toEqual(daysFromNow(10, 19));
  });

  it("AC16: deve recusar com 409 mudar o horário de sessão com reserva confirmada", async () => {
    // GIVEN a future session with a confirmed booking
    const { room, session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    await insertBooking(ctx, session.id, room.id, "confirmed");

    // WHEN the admin moves it one hour later
    const response = await updateSessionAsAdmin(ctx, session.id, { startsAt: daysFromNow(10, 20).toISOString() });

    // THEN it is refused with 409 and the time stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, session.id))?.startsAt).toEqual(daysFromNow(10, 19));
  });

  it("AC16: deve recusar com 409 mudar o horário de sessão com assento segurado", async () => {
    // GIVEN a future session where a customer is holding a seat
    const { room, session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    await holdFirstSeatAsCustomer(ctx, session.id, room.id);

    // WHEN the admin moves it one hour later
    const response = await updateSessionAsAdmin(ctx, session.id, { startsAt: daysFromNow(10, 20).toISOString() });

    // THEN it is refused with 409 and the time stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, session.id))?.startsAt).toEqual(daysFromNow(10, 19));
  });

  it("AC16: deve permitir mudar o horário de sessão cuja reserva pendente já passou do prazo sem pagamento em andamento", async () => {
    // GIVEN a future session whose only booking is pending, past its deadline, with no payment in flight
    const { room, session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    await insertAbandonedPendingBooking(ctx, session.id, room.id);

    // WHEN the admin moves it one hour later
    const response = await updateSessionAsAdmin(ctx, session.id, { startsAt: daysFromNow(10, 20).toISOString() });

    // THEN the new time is saved, since that booking no longer locks any seat
    expect(response.statusCode).toBe(200);
    expect((await findSessionInDb(ctx, session.id))?.startsAt).toEqual(daysFromNow(10, 20));
  });

  it("AC16: deve permitir mudar o horário de sessão que só tem reserva expirada", async () => {
    // GIVEN a future session whose only booking is expired
    const { room, session } = await createScheduledSession(ctx, daysFromNow(10, 19));
    await insertBooking(ctx, session.id, room.id, "expired");

    // WHEN the admin moves it one hour later
    const response = await updateSessionAsAdmin(ctx, session.id, { startsAt: daysFromNow(10, 20).toISOString() });

    // THEN the new time is saved
    expect(response.statusCode).toBe(200);
    expect((await findSessionInDb(ctx, session.id))?.startsAt).toEqual(daysFromNow(10, 20));
  });

  it("AC16: deve recusar com 409 mudar o preço de sessão com reserva pendente", async () => {
    // GIVEN a future session priced at 3000 with a pending booking
    const { room, session } = await createScheduledSession(ctx);
    await insertBooking(ctx, session.id, room.id, "pending");

    // WHEN the admin changes the price
    const response = await updateSessionAsAdmin(ctx, session.id, { priceCents: 4000 });

    // THEN it is refused with 409 and the price stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, session.id))?.priceCents).toBe(3000);
  });

  it("AC16: deve recusar com 409 mudar o preço de sessão com assento segurado", async () => {
    // GIVEN a future session priced at 3000 where a customer is holding a seat
    const { room, session } = await createScheduledSession(ctx);
    await holdFirstSeatAsCustomer(ctx, session.id, room.id);

    // WHEN the admin changes the price
    const response = await updateSessionAsAdmin(ctx, session.id, { priceCents: 4000 });

    // THEN it is refused with 409 and the price stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, session.id))?.priceCents).toBe(3000);
  });

  it("AC16: deve permitir mudar o preço de sessão que só tem reservas confirmadas, sem alterar o preço já pago", async () => {
    // GIVEN a future session priced at 3000 with a confirmed booking paid at 3000
    const { room, session } = await createScheduledSession(ctx);
    const { bookingId } = await insertBooking(ctx, session.id, room.id, "confirmed", 3000);

    // WHEN the admin raises the price to 4500
    const response = await updateSessionAsAdmin(ctx, session.id, { priceCents: 4500 });

    // THEN the new price is saved and the sold seat keeps the price it was paid at
    expect(response.statusCode).toBe(200);
    expect((await findSessionInDb(ctx, session.id))?.priceCents).toBe(4500);
    expect(await bookedSeatPrices(ctx, bookingId)).toEqual([3000]);
  });

  it("AC17: deve excluir sessão futura sem reservas nem holds e tirá-la do catálogo", async () => {
    // GIVEN a future session listed in the catalog
    const { session } = await createScheduledSession(ctx);
    expect(await catalogSessionIds(ctx)).toContain(session.id);

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it answers 204 and the session is gone from the catalog
    expect(response.statusCode).toBe(204);
    expect(await catalogSessionIds(ctx)).not.toContain(session.id);
    expect(await findSessionInDb(ctx, session.id)).toBeUndefined();
  });

  it("AC17: deve recusar com 409 excluir sessão com assento segurado", async () => {
    // GIVEN a future session where a customer is holding a seat
    const { room, session } = await createScheduledSession(ctx);
    await holdFirstSeatAsCustomer(ctx, session.id, room.id);

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it is refused with 409 and the session stays
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
  });

  it("AC17: deve recusar com 409 excluir sessão com reserva pendente", async () => {
    // GIVEN a future session with a pending booking
    const { room, session } = await createScheduledSession(ctx);
    await insertBooking(ctx, session.id, room.id, "pending");

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it is refused with 409 and nothing is deleted
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
    expect(await countBookingsOfSession(ctx, session.id)).toBe(1);
  });

  it("AC17: deve recusar com 409 excluir sessão com reserva confirmada", async () => {
    // GIVEN a future session with a confirmed booking
    const { room, session } = await createScheduledSession(ctx);
    await insertBooking(ctx, session.id, room.id, "confirmed");

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it is refused with 409 and nothing is deleted
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
    expect(await countBookingsOfSession(ctx, session.id)).toBe(1);
  });

  it("AC17: deve recusar com 409 excluir sessão com reserva cancelada", async () => {
    // GIVEN a future session with a cancelled booking (kept as payment history)
    const { room, session } = await createScheduledSession(ctx);
    await insertBooking(ctx, session.id, room.id, "cancelled");

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it is refused with 409 and nothing is deleted
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
    expect(await countBookingsOfSession(ctx, session.id)).toBe(1);
  });

  it("AC17: deve recusar com 409 excluir sessão com reserva expirada", async () => {
    // GIVEN a future session with an expired booking (kept as history)
    const { room, session } = await createScheduledSession(ctx);
    await insertBooking(ctx, session.id, room.id, "expired");

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, session.id);

    // THEN it is refused with 409 and nothing is deleted
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
    expect(await countBookingsOfSession(ctx, session.id)).toBe(1);
  });

  it("AC18: deve recusar com 409 editar sessão que já começou", async () => {
    // GIVEN a session that started 10 minutes ago
    const { movie, room } = await createRoomWithMovie(ctx);
    const sessionId = await insertSessionDirectly(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(new Date(), -10),
      priceCents: 3000,
    });

    // WHEN the admin changes its price
    const response = await updateSessionAsAdmin(ctx, sessionId, { priceCents: 5000 });

    // THEN it is refused with 409 and the price stays
    expect(response.statusCode).toBe(409);
    expect((await findSessionInDb(ctx, sessionId))?.priceCents).toBe(3000);
  });

  it("AC18: deve recusar com 409 excluir sessão que já começou", async () => {
    // GIVEN a session that started 10 minutes ago
    const { movie, room } = await createRoomWithMovie(ctx);
    const sessionId = await insertSessionDirectly(ctx, {
      movieId: movie.id,
      roomId: room.id,
      startsAt: plusMinutes(new Date(), -10),
    });

    // WHEN the admin deletes it
    const response = await deleteSessionAsAdmin(ctx, sessionId);

    // THEN it is refused with 409 and the session stays
    expect(response.statusCode).toBe(409);
    expect(await findSessionInDb(ctx, sessionId)).toBeDefined();
  });
});
