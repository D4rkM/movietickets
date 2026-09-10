import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { JwtPayload } from "./jwt-payload.type";

type FakeRequest = { headers: Record<string, string>; user?: JwtPayload };

function buildContext(headers: Record<string, string> = {}): { context: ExecutionContext; request: FakeRequest } {
  const request: FakeRequest = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("JwtAuthGuard", () => {
  const mockJwtService = { verifyAsync: jest.fn() };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new JwtAuthGuard(mockJwtService as unknown as JwtService);
  });

  it("throws UnauthorizedException when there is no Authorization header", async () => {
    const { context } = buildContext();

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when the header is not a Bearer token", async () => {
    const { context } = buildContext({ authorization: "Basic abc123" });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when the token is invalid or expired", async () => {
    const { context } = buildContext({ authorization: "Bearer bad-token" });
    mockJwtService.verifyAsync.mockRejectedValue(new Error("jwt expired"));

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("allows the request and attaches the payload when the token is valid", async () => {
    const payload = { sub: "1", email: "ana@test.com", role: "customer" };
    const { context, request } = buildContext({ authorization: "Bearer good-token" });
    mockJwtService.verifyAsync.mockResolvedValue(payload);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toEqual(payload);
  });
});
