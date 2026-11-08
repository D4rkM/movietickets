import {
  AdminTestContext,
  createCinemaAsAdmin,
  listCinemasAsAdmin,
  postCinemaAsAdmin,
  startAdminApp,
  updateCinemaAsAdmin,
} from "./helpers/admin";

describe("Painel admin: cinemas (e2e)", () => {
  let ctx: AdminTestContext;

  beforeAll(async () => {
    ctx = await startAdminApp("admin-cinemas");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("AC8: deve criar um cinema e listá-lo", async () => {
    // GIVEN an admin

    // WHEN the admin creates a cinema
    const cinema = await createCinemaAsAdmin(ctx, { name: `${ctx.label} Cine Centro`, city: "Campinas" });

    // THEN the cinema is returned and shows up in the admin list
    expect(cinema).toEqual(
      expect.objectContaining({ name: `${ctx.label} Cine Centro`, address: "Rua Admin, 10", city: "Campinas" }),
    );
    expect(await listCinemasAsAdmin(ctx)).toContainEqual(cinema);
  });

  it("AC8: deve editar nome, endereço e cidade de um cinema", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin edits its fields
    const response = await updateCinemaAsAdmin(ctx, cinema.id, {
      name: `${ctx.label} Cine Renomeado`,
      address: "Av. Nova, 200",
      city: "Santos",
    });

    // THEN the change is saved and listed
    expect(response.statusCode).toBe(200);
    const expected = { id: cinema.id, name: `${ctx.label} Cine Renomeado`, address: "Av. Nova, 200", city: "Santos" };
    expect(response.json()).toEqual(expected);
    expect(await listCinemasAsAdmin(ctx)).toContainEqual(expected);
  });

  it("AC8: deve recusar com 400 criar cinema com nome vazio", async () => {
    // GIVEN a cinema payload with a blank name
    const payload = { name: "   ", address: "Rua A, 1", city: "Testópolis" };

    // WHEN the admin creates it
    const response = await postCinemaAsAdmin(ctx, payload);

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC8: deve recusar com 400 criar cinema sem cidade", async () => {
    // GIVEN a cinema payload without a city
    const payload = { name: `${ctx.label} Sem Cidade`, address: "Rua A, 1" };

    // WHEN the admin creates it
    const response = await postCinemaAsAdmin(ctx, payload);

    // THEN it is refused with 400
    expect(response.statusCode).toBe(400);
  });

  it("AC8: deve recusar com 400 editar cinema deixando o endereço vazio", async () => {
    // GIVEN an existing cinema
    const cinema = await createCinemaAsAdmin(ctx);

    // WHEN the admin empties its address
    const response = await updateCinemaAsAdmin(ctx, cinema.id, { address: "" });

    // THEN it is refused with 400 and the address stays the same
    expect(response.statusCode).toBe(400);
    expect((await listCinemasAsAdmin(ctx)).find((listed) => listed.id === cinema.id)?.address).toBe(cinema.address);
  });
});
