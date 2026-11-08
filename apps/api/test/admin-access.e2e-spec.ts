import {
  AdminTestContext,
  callAsCustomer,
  callWithToken,
  countMoviesTitled,
  createScheduledSession,
  expiredAdminToken,
  findSessionInDb,
  startAdminApp,
  validMoviePayload,
} from "./helpers/admin";
import { obtainGuestIdentity } from "./helpers/guest-flow";

describe("Painel admin: autorização (e2e)", () => {
  let ctx: AdminTestContext;

  beforeAll(async () => {
    ctx = await startAdminApp("admin-access");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("AC1: deve recusar com 401 rota admin de leitura e de escrita chamada sem token", async () => {
    // GIVEN no Authorization header

    // WHEN listing movies and creating a movie under /admin
    const read = await callWithToken(ctx, undefined, "GET", "/admin/movies");
    const write = await callWithToken(ctx, undefined, "POST", "/admin/movies", validMoviePayload(ctx));

    // THEN both are refused with 401
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });

  it("AC1: deve recusar com 401 rota admin de leitura e de escrita chamada com token inválido", async () => {
    // GIVEN a token that isn't a valid JWT
    const invalidToken = "not-a-jwt";

    // WHEN listing sessions and creating a cinema under /admin
    const read = await callWithToken(ctx, invalidToken, "GET", "/admin/sessions");
    const write = await callWithToken(ctx, invalidToken, "POST", "/admin/cinemas", {
      name: "Cinema",
      address: "Rua",
      city: "Cidade",
    });

    // THEN both are refused with 401
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });

  it("AC1: deve recusar com 401 rota admin de leitura e de escrita chamada com token de admin expirado", async () => {
    // GIVEN an admin token that expired a minute ago
    const token = expiredAdminToken(ctx);

    // WHEN listing rooms and creating a movie under /admin
    const read = await callWithToken(ctx, token, "GET", "/admin/rooms");
    const write = await callWithToken(ctx, token, "POST", "/admin/movies", validMoviePayload(ctx));

    // THEN both are refused with 401
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });

  it("AC2: deve recusar com 403 usuário cliente tentando criar filme", async () => {
    // GIVEN a logged-in customer and a movie title nobody has used
    const payload = validMoviePayload(ctx, { title: `${ctx.label} filme do cliente` });

    // WHEN the customer tries to create the movie
    const response = await callAsCustomer(ctx, "POST", "/admin/movies", payload);

    // THEN it is refused with 403 and no movie is stored
    expect(response.statusCode).toBe(403);
    expect(await countMoviesTitled(ctx, payload.title as string)).toBe(0);
  });

  it("AC2: deve recusar com 403 usuário cliente tentando excluir sessão", async () => {
    // GIVEN a future session created by the admin
    const { session } = await createScheduledSession(ctx);

    // WHEN a logged-in customer tries to delete it
    const response = await callAsCustomer(ctx, "DELETE", `/admin/sessions/${session.id}`);

    // THEN it is refused with 403 and the session is still there
    expect(response.statusCode).toBe(403);
    expect(await findSessionInDb(ctx, session.id)).toBeDefined();
  });

  it("AC2: deve recusar com 403 usuário cliente tentando listar filmes do admin", async () => {
    // GIVEN a logged-in customer

    // WHEN the customer reads an admin list
    const response = await callAsCustomer(ctx, "GET", "/admin/movies");

    // THEN it is refused with 403
    expect(response.statusCode).toBe(403);
  });

  it("AC3: deve recusar com 401 token de convidado numa rota admin", async () => {
    // GIVEN a visitor with a guest token from POST /auth/guest
    const guest = await obtainGuestIdentity(ctx.app, ctx.jwtService);

    // WHEN the guest calls an admin read route and an admin write route
    const read = await callWithToken(ctx, guest.guestToken, "GET", "/admin/movies");
    const write = await callWithToken(ctx, guest.guestToken, "POST", "/admin/movies", validMoviePayload(ctx));

    // THEN both are refused with 401
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });
});
