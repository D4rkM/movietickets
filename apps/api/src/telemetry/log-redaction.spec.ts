import pino from "pino";
import { Writable } from "node:stream";
import { LOG_REDACT_PATHS } from "./log-redaction";

function captureLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino({ redact: [...LOG_REDACT_PATHS] }, destination), lines };
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
          headers: { authorization: "Bearer secret-jwt", cookie: "sid=secret-cookie", host: "localhost" },
          body: {
            password: "secret-password",
            guestToken: "secret-guest-token",
            token: "secret-card-token",
            payer: { email: "payer@example.com", identification: { number: "12345678909" } },
          },
        },
        res: { statusCode: 200, headers: { "set-cookie": "sid=secret-set-cookie" } },
      },
      "request completed",
    );

    // ASSERT
    const record = JSON.parse(lines[0]);
    expect(record.req.headers).toEqual({ authorization: "[Redacted]", cookie: "[Redacted]", host: "localhost" });
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
