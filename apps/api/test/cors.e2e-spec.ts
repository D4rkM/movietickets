import { ConfigModule } from "@nestjs/config";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { CatalogModule } from "../src/catalog/catalog.module";
import { corsOptions } from "../src/cors-options";
import { DrizzleModule } from "../src/db/drizzle.module";
import { buildFastifyApp } from "./helpers/build-app";

describe("CORS (e2e)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DrizzleModule, CatalogModule],
    }).compile();

    app = await buildFastifyApp(moduleRef);
    app.enableCors(corsOptions());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should allow a DELETE preflight from the configured web origin", async () => {
    // GIVEN a browser about to send a DELETE request (seat/hold release, booking cancellation)

    // WHEN it sends the CORS preflight
    const response = await app.inject({
      method: "OPTIONS",
      url: "/sessions/any-session/holds",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "DELETE",
      },
    });

    // THEN the preflight approves DELETE — this is what actually gates whether
    // the browser sends the real request at all, regardless of what the route
    // itself would respond with
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("should reject a preflight from an origin outside CORS_ORIGIN", async () => {
    // GIVEN a request from an unrelated origin

    // WHEN it sends the CORS preflight
    const response = await app.inject({
      method: "OPTIONS",
      url: "/sessions/any-session/holds",
      headers: {
        origin: "http://evil.example.com",
        "access-control-request-method": "DELETE",
      },
    });

    // THEN it isn't granted access
    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});
