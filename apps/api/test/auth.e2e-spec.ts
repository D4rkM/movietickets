import { ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AuthModule } from "../src/auth/auth.module";
import { DrizzleModule } from "../src/db/drizzle.module";
import * as schema from "../src/db/schema";
import { buildFastifyApp } from "./helpers/build-app";

describe("Auth (e2e)", () => {
  let app: NestFastifyApplication;
  let db: PostgresJsDatabase<typeof schema>;
  let cleanupClient: ReturnType<typeof postgres>;
  const email = `auth-e2e-${Date.now()}@test.com`;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret";

    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, AuthModule],
    }).compile();

    app = await buildFastifyApp(moduleRef);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.email, email));
    await cleanupClient.end();
    await app.close();
  });

  // Os testes abaixo compartilham estado (mesmo email) e rodam nesta ordem de propósito:
  // registro -> registro duplicado -> login -> login errado.

  it("should register a new user and return an access token", async () => {
    // GIVEN nenhum usuário cadastrado com este e-mail

    // WHEN o cliente chama POST /auth/register
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana", email, password: "password123" },
    });

    // THEN retorna 201 com token e os dados do usuário criado
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.user.email).toBe(email);
  });

  it("should reject registering the same email twice", async () => {
    // GIVEN um usuário já cadastrado com este e-mail (teste anterior)

    // WHEN o cliente tenta registrar de novo com o mesmo e-mail
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana", email, password: "password123" },
    });

    // THEN retorna 409 (conflito)
    expect(response.statusCode).toBe(409);
  });

  it("should log in with valid credentials", async () => {
    // GIVEN um usuário cadastrado com este e-mail/senha

    // WHEN o cliente chama POST /auth/login com as credenciais corretas
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "password123" },
    });

    // THEN retorna 200 com token de acesso
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
  });

  it("should reject login with wrong password", async () => {
    // GIVEN um usuário cadastrado com este e-mail

    // WHEN o cliente chama POST /auth/login com senha errada
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });

    // THEN retorna 401
    expect(response.statusCode).toBe(401);
  });
});
