import pino from "pino";
import { Writable } from "node:stream";
import { LOG_REDACT_PATHS, omitClientIdentity } from "./log-redaction";

function captureLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: pino({ redact: [...LOG_REDACT_PATHS] }, destination),
    lines,
  };
}

describe("LOG_REDACT_PATHS", () => {
  it("should cover the credentials and payer data listed in the observability spec", () => {
    // ARRANGE
    const expected = [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "req.body.password",
      "req.body.guestToken",
      "req.body.token",
      "req.body.payer",
    ];

    // ACT
    const paths = [...LOG_REDACT_PATHS];

    // ASSERT
    expect(paths).toEqual(expect.arrayContaining(expected));
  });

  it("should replace every sensitive value with [Redacted] in the serialized log", () => {
    // ARRANGE
    const { logger, lines } = captureLogger();

    // ACT
    logger.info(
      {
        req: {
          method: "POST",
          headers: {
            authorization: "Bearer secret-jwt",
            cookie: "sid=secret-cookie",
            host: "localhost",
          },
          body: {
            password: "secret-password",
            guestToken: "secret-guest-token",
            token: "secret-card-token",
            payer: {
              email: "payer@example.com",
              identification: { number: "12345678909" },
            },
          },
        },
        res: {
          statusCode: 200,
          headers: { "set-cookie": "sid=secret-set-cookie" },
        },
      },
      "request completed",
    );

    // ASSERT
    const record = JSON.parse(lines[0]);
    expect(record.req.headers).toEqual({
      authorization: "[Redacted]",
      cookie: "[Redacted]",
      host: "localhost",
    });
    expect(record.req.body).toEqual({
      password: "[Redacted]",
      guestToken: "[Redacted]",
      token: "[Redacted]",
      payer: "[Redacted]",
    });
    expect(record.res.headers["set-cookie"]).toBe("[Redacted]");
    expect(lines[0]).not.toMatch(/secret|payer@example\.com|12345678909/);
  });
});

describe("omitClientIdentity", () => {
  const serializedReq = {
    id: 1,
    method: "GET",
    url: "/movies",
    headers: {
      host: "localhost",
      "user-agent": "SmokeBrowser/1.0",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      authorization: "Bearer secret-jwt",
    },
    remoteAddress: "203.0.113.7",
    remotePort: 54321,
  };

  it("should drop the client address, port and identifying headers from the request", () => {
    // ARRANGE
    const input = structuredClone(serializedReq);

    // ACT
    const result = omitClientIdentity(input);

    // ASSERT
    expect(result).toEqual({
      id: 1,
      method: "GET",
      url: "/movies",
      headers: { host: "localhost", authorization: "Bearer secret-jwt" },
    });
    expect(input).toEqual(serializedReq);
  });

  it("should keep secrets masked as [Redacted] when combined with LOG_REDACT_PATHS", () => {
    // ARRANGE
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      {
        redact: [...LOG_REDACT_PATHS],
        serializers: { req: omitClientIdentity },
      },
      destination,
    );

    // ACT
    logger.info({ req: structuredClone(serializedReq) }, "request completed");

    // ASSERT
    const record = JSON.parse(lines[0]);
    expect(record.req.headers).toEqual({
      host: "localhost",
      authorization: "[Redacted]",
    });
    expect(lines[0]).not.toMatch(/203\.0\.113\.7|SmokeBrowser|54321|remoteAddress|remotePort/);
  });

  it("should leave a request without headers untouched except for the address fields", () => {
    // ARRANGE
    const input = { method: "GET", remoteAddress: "203.0.113.7" };

    // ACT
    const result = omitClientIdentity(input as { headers?: Record<string, unknown> });

    // ASSERT
    expect(result).toEqual({ method: "GET" });
  });
});
