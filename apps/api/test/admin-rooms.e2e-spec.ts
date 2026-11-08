import {
  AdminTestContext,
  createCinemaAsAdmin,
  createMovieAsAdmin,
  createRoomAsAdmin,
  createSessionAsAdmin,
  daysFromNow,
  deleteRoomAsAdmin,
  findRoomInDb,
  insertSessionDirectly,
  postRoomAsAdmin,
  seatLabelsOfRoom,
  startAdminApp,
  updateRoomAsAdmin,
} from "./helpers/admin";

describe("Painel admin: salas e assentos (e2e)", () => {
  let ctx: AdminTestContext;

  beforeAll(async () => {
    ctx = await startAdminApp("admin-rooms");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("AC9: deve gerar 12 assentos A1 a C4 ao criar sala 3 × 4", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin creates a 3-row room with 4 seats per row
    const room = await createRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 3x4", rows: 3, seatsPerRow: 4 });

    // THEN the room is stored with exactly 12 seats, rows A to C numbered 1 to 4
    expect(room).toEqual(
      expect.objectContaining({ name: "Sala 3x4", rows: 3, seatsPerRow: 4, cinemaId: cinema.id, cinemaName: cinema.name }),
    );
    expect(await seatLabelsOfRoom(ctx, room.id)).toEqual([
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4",
      "C1", "C2", "C3", "C4",
    ]);
  });

  it("AC10: deve recusar com 400 sala com 0 fileiras", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin creates a room with 0 rows
    const response = await postRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala Zero", rows: 0, seatsPerRow: 10 });

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC10: deve recusar com 400 sala com 27 fileiras", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin creates a room with 27 rows (past "Z")
    const response = await postRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 27", rows: 27, seatsPerRow: 10 });

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC10: deve recusar com 400 sala com 41 assentos por fileira", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin creates a room with 41 seats per row
    const response = await postRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 41", rows: 5, seatsPerRow: 41 });

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC10: deve recusar com 404 sala em cinema inexistente", async () => {
    // GIVEN a cinema id that doesn't exist
    const unknownCinemaId = "00000000-0000-4000-8000-000000000000";

    // WHEN the admin creates a room in it
    const response = await postRoomAsAdmin(ctx, { cinemaId: unknownCinemaId, name: "Sala", rows: 2, seatsPerRow: 2 });

    // THEN it is refused with 404
    expect(response.statusCode).toBe(404);
  });

  it("AC10: deve recusar com 409 sala com nome já usado no mesmo cinema", async () => {
    // GIVEN a cinema that already has a "Sala 1"
    const cinema = await createCinemaAsAdmin(ctx);
    await createRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 1" });

    // WHEN the admin creates another "Sala 1" there
    const response = await postRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 1", rows: 2, seatsPerRow: 2 });

    // THEN it is refused with 409
    expect(response.statusCode).toBe(409);
  });

  it("AC10: deve aceitar sala com o mesmo nome em cinema diferente", async () => {
    // GIVEN a "Sala 1" in one cinema and a second cinema
    const firstCinema = await createCinemaAsAdmin(ctx);
    await createRoomAsAdmin(ctx, { cinemaId: firstCinema.id, name: "Sala 1" });
    const secondCinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin creates a "Sala 1" in the second cinema
    const response = await postRoomAsAdmin(ctx, { cinemaId: secondCinema.id, name: "Sala 1", rows: 2, seatsPerRow: 2 });

    // THEN it is created
    expect(response.statusCode).toBe(201);
  });

  it("AC10: deve recusar com 409 renomear sala para nome já usado no mesmo cinema", async () => {
    // GIVEN a cinema with "Sala 1" and "Sala 2"
    const cinema = await createCinemaAsAdmin(ctx);
    await createRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 1" });
    const room = await createRoomAsAdmin(ctx, { cinemaId: cinema.id, name: "Sala 2" });

    // WHEN the admin renames "Sala 2" to "Sala 1"
    const response = await updateRoomAsAdmin(ctx, room.id, { name: "Sala 1" });

    // THEN it is refused with 409 and the name stays
    expect(response.statusCode).toBe(409);
    expect((await findRoomInDb(ctx, room.id))?.name).toBe("Sala 2");
  });

  it("AC11: deve regerar os assentos ao mudar o layout de sala sem sessões", async () => {
    // GIVEN a 3 × 4 room without sessions
    const room = await createRoomAsAdmin(ctx, { rows: 3, seatsPerRow: 4 });

    // WHEN the admin changes it to 2 × 2
    const response = await updateRoomAsAdmin(ctx, room.id, { rows: 2, seatsPerRow: 2 });

    // THEN the room is 2 × 2 and its seats are exactly A1, A2, B1, B2
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ rows: 2, seatsPerRow: 2 }));
    expect(await seatLabelsOfRoom(ctx, room.id)).toEqual(["A1", "A2", "B1", "B2"]);
  });

  it("AC11: deve recusar com 409 mudar o layout de sala com sessão e manter os assentos", async () => {
    // GIVEN a 3 × 4 room with a future session
    const room = await createRoomAsAdmin(ctx, { rows: 3, seatsPerRow: 4 });
    const movie = await createMovieAsAdmin(ctx);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(6) });
    const seatsBefore = await seatLabelsOfRoom(ctx, room.id);

    // WHEN the admin adds a row
    const response = await updateRoomAsAdmin(ctx, room.id, { rows: 4 });

    // THEN it is refused with 409 and seats and layout stay as they were
    expect(response.statusCode).toBe(409);
    expect(await seatLabelsOfRoom(ctx, room.id)).toEqual(seatsBefore);
    expect((await findRoomInDb(ctx, room.id))?.rows).toBe(3);
  });

  it("AC11: deve permitir renomear sala com sessões", async () => {
    // GIVEN a room with a future session
    const room = await createRoomAsAdmin(ctx, { name: "Sala Antiga" });
    const movie = await createMovieAsAdmin(ctx);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(6) });

    // WHEN the admin renames it
    const response = await updateRoomAsAdmin(ctx, room.id, { name: "Sala Nova" });

    // THEN the new name is saved
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("Sala Nova");
    expect((await findRoomInDb(ctx, room.id))?.name).toBe("Sala Nova");
  });

  it("AC19: deve excluir sala sem sessões junto com os assentos", async () => {
    // GIVEN a room without sessions
    const room = await createRoomAsAdmin(ctx);

    // WHEN the admin deletes it
    const response = await deleteRoomAsAdmin(ctx, room.id);

    // THEN it answers 204 and neither the room nor its seats remain
    expect(response.statusCode).toBe(204);
    expect(await findRoomInDb(ctx, room.id)).toBeUndefined();
    expect(await seatLabelsOfRoom(ctx, room.id)).toEqual([]);
  });

  it("AC19: deve recusar com 409 excluir sala com sessão e não apagar nada", async () => {
    // GIVEN a room whose only session happened yesterday
    const room = await createRoomAsAdmin(ctx);
    const movie = await createMovieAsAdmin(ctx);
    await insertSessionDirectly(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(-1) });
    const seatsBefore = await seatLabelsOfRoom(ctx, room.id);

    // WHEN the admin deletes the room
    const response = await deleteRoomAsAdmin(ctx, room.id);

    // THEN it is refused with 409 and the room and its seats stay
    expect(response.statusCode).toBe(409);
    expect(await findRoomInDb(ctx, room.id)).toBeDefined();
    expect(await seatLabelsOfRoom(ctx, room.id)).toEqual(seatsBefore);
  });
});
