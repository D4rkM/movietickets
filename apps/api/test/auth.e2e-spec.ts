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

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, AuthModule],
    }).compile();

    // ConfigModule.forRoot() above loads .env into process.env as a side effect,
    // so DATABASE_URL is only reliable after the module has compiled.
    cleanupClient = postgres(process.env.DATABASE_URL!);
    db = drizzle(cleanupClient, { schema });

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

  // The tests below share state (same email) and run in this order on purpose:
  // register -> duplicate register -> login -> wrong-password login.

  it("should register a new user without issuing an access token", async () => {
    // GIVEN no user registered with this email

    // WHEN the client calls POST /auth/register
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana", email, password: "password123" },
    });

    // THEN it returns 201 with the created user's data, and no token
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.email).toBe(email);
  });

  it("should reject registering the same email twice", async () => {
    // GIVEN a user already registered with this email (previous test)

    // WHEN the client tries to register again with the same email
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana", email, password: "password123" },
    });

    // THEN it returns 409 (conflict)
    expect(response.statusCode).toBe(409);
  });

  it("should log in with valid credentials", async () => {
    // GIVEN a user registered with this email/password

    // WHEN the client calls POST /auth/login with the correct credentials
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "password123" },
    });

    // THEN it returns 200 with an access token
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBeDefined();
  });

  it("should reject login with wrong password", async () => {
    // GIVEN a user registered with this email

    // WHEN the client calls POST /auth/login with the wrong password
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });

    // THEN it returns 401
    expect(response.statusCode).toBe(401);
  });
});
