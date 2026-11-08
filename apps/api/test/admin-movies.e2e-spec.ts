import {
  AdminTestContext,
  catalogMovie,
  countMoviesTitled,
  createMovieAsAdmin,
  createRoomAsAdmin,
  createSessionAsAdmin,
  daysFromNow,
  deleteMovieAsAdmin,
  findMovieInDb,
  insertSessionDirectly,
  plusMinutes,
  postMovieAsAdmin,
  startAdminApp,
  updateMovieAsAdmin,
  validMoviePayload,
} from "./helpers/admin";

describe("Painel admin: filmes (e2e)", () => {
  let ctx: AdminTestContext;

  beforeAll(async () => {
    ctx = await startAdminApp("admin-movies");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("AC4: deve mostrar no catálogo, na resposta seguinte, o filme e a sessão futura criados pelo admin", async () => {
    // GIVEN an admin who creates a movie and a future session for it
    const movie = await createMovieAsAdmin(ctx, { title: `${ctx.label} Estreia` });
    const room = await createRoomAsAdmin(ctx);
    const session = await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(3) });

    // WHEN anyone reads the public catalog right after
    const listed = await catalogMovie(ctx, movie.id);

    // THEN the movie is there with that session
    expect(listed?.title).toBe(`${ctx.label} Estreia`);
    expect(listed?.sessions.map((catalogSession) => catalogSession.id)).toEqual([session.id]);
  });

  it("AC5: deve recusar com 400 criar filme com título vazio", async () => {
    // GIVEN a movie payload with an empty title
    const payload = validMoviePayload(ctx, { title: "" });

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC5: deve recusar com 400 criar filme com duração 0", async () => {
    // GIVEN a movie payload lasting 0 minutes
    const payload = validMoviePayload(ctx, { title: `${ctx.label} duração zero`, durationMinutes: 0 });

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countMoviesTitled(ctx, payload.title as string)).toBe(0);
  });

  it("AC5: deve recusar com 400 criar filme com duração 601", async () => {
    // GIVEN a movie payload lasting 601 minutes
    const payload = validMoviePayload(ctx, { title: `${ctx.label} duração 601`, durationMinutes: 601 });

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countMoviesTitled(ctx, payload.title as string)).toBe(0);
  });

  it("AC5: deve recusar com 400 criar filme com posterUrl que não é http/https", async () => {
    // GIVEN a movie payload whose poster URL uses ftp
    const payload = validMoviePayload(ctx, { title: `${ctx.label} pôster ftp`, posterUrl: "ftp://example.com/p.jpg" });

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countMoviesTitled(ctx, payload.title as string)).toBe(0);
  });

  it("AC5: deve recusar com 400 criar filme com classificação fora da lista", async () => {
    // GIVEN a movie payload rated "15", which isn't a Brazilian rating
    const payload = validMoviePayload(ctx, { title: `${ctx.label} classificação 15`, rating: "15" });

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is refused with 400 and nothing is stored
    expect(response.statusCode).toBe(400);
    expect(await countMoviesTitled(ctx, payload.title as string)).toBe(0);
  });

  it("AC5: deve aceitar criar filme sem classificação", async () => {
    // GIVEN a movie payload without rating and with an https poster
    const payload = { title: `${ctx.label} sem classificação`, durationMinutes: 95, posterUrl: "https://example.com/p.jpg" };

    // WHEN the admin creates it
    const response = await postMovieAsAdmin(ctx, payload);

    // THEN it is created with no rating
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(expect.objectContaining({ ...payload, rating: null }));
  });

  it("AC5: deve recusar com 400 editar filme com classificação fora da lista e manter a anterior", async () => {
    // GIVEN a movie rated "14"
    const movie = await createMovieAsAdmin(ctx, { rating: "14" });

    // WHEN the admin changes the rating to "livre"
    const response = await updateMovieAsAdmin(ctx, movie.id, { rating: "livre" });

    // THEN it is refused with 400 and the rating stays "14"
    expect(response.statusCode).toBe(400);
    expect((await findMovieInDb(ctx, movie.id))?.rating).toBe("14");
  });

  it("AC6: deve recusar com 409 nova duração que faz uma sessão futura invadir a seguinte na mesma sala", async () => {
    // GIVEN a 120-min movie at 19:00 followed by another session at 21:00 in the same room
    const movie = await createMovieAsAdmin(ctx, { durationMinutes: 120 });
    const nextMovie = await createMovieAsAdmin(ctx, { durationMinutes: 90 });
    const room = await createRoomAsAdmin(ctx);
    const startsAt = daysFromNow(5, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt });
    await createSessionAsAdmin(ctx, { movieId: nextMovie.id, roomId: room.id, startsAt: plusMinutes(startsAt, 120) });

    // WHEN the admin stretches the first movie to 121 minutes
    const response = await updateMovieAsAdmin(ctx, movie.id, { durationMinutes: 121 });

    // THEN it is refused with 409 and the duration stays 120
    expect(response.statusCode).toBe(409);
    expect((await findMovieInDb(ctx, movie.id))?.durationMinutes).toBe(120);
  });

  it("AC6: deve aceitar nova duração que não cria sobreposição", async () => {
    // GIVEN a 120-min movie at 19:00 followed by another session at 22:00 in the same room
    const movie = await createMovieAsAdmin(ctx, { durationMinutes: 120 });
    const nextMovie = await createMovieAsAdmin(ctx, { durationMinutes: 90 });
    const room = await createRoomAsAdmin(ctx);
    const startsAt = daysFromNow(5, 19);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt });
    await createSessionAsAdmin(ctx, { movieId: nextMovie.id, roomId: room.id, startsAt: plusMinutes(startsAt, 180) });

    // WHEN the admin stretches the first movie to exactly 180 minutes
    const response = await updateMovieAsAdmin(ctx, movie.id, { durationMinutes: 180 });

    // THEN it is accepted and saved
    expect(response.statusCode).toBe(200);
    expect(response.json().durationMinutes).toBe(180);
    expect((await findMovieInDb(ctx, movie.id))?.durationMinutes).toBe(180);
  });

  it("AC7: deve excluir filme sem nenhuma sessão e tirá-lo do catálogo", async () => {
    // GIVEN a movie without sessions, listed in the catalog
    const movie = await createMovieAsAdmin(ctx);
    expect(await catalogMovie(ctx, movie.id)).toBeDefined();

    // WHEN the admin deletes it
    const response = await deleteMovieAsAdmin(ctx, movie.id);

    // THEN it answers 204 and the movie is gone from the catalog
    expect(response.statusCode).toBe(204);
    expect(await catalogMovie(ctx, movie.id)).toBeUndefined();
    expect(await findMovieInDb(ctx, movie.id)).toBeUndefined();
  });

  it("AC7: deve recusar com 409 excluir filme com sessão futura", async () => {
    // GIVEN a movie with a future session
    const movie = await createMovieAsAdmin(ctx);
    const room = await createRoomAsAdmin(ctx);
    await createSessionAsAdmin(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(4) });

    // WHEN the admin deletes the movie
    const response = await deleteMovieAsAdmin(ctx, movie.id);

    // THEN it is refused with 409 and the movie stays
    expect(response.statusCode).toBe(409);
    expect(await findMovieInDb(ctx, movie.id)).toBeDefined();
  });

  it("AC7: deve recusar com 409 excluir filme que só tem sessão passada", async () => {
    // GIVEN a movie whose only session happened yesterday
    const movie = await createMovieAsAdmin(ctx);
    const room = await createRoomAsAdmin(ctx);
    await insertSessionDirectly(ctx, { movieId: movie.id, roomId: room.id, startsAt: daysFromNow(-1) });

    // WHEN the admin deletes the movie
    const response = await deleteMovieAsAdmin(ctx, movie.id);

    // THEN it is refused with 409 and the movie stays
    expect(response.statusCode).toBe(409);
    expect(await findMovieInDb(ctx, movie.id)).toBeDefined();
  });
});
