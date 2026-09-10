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

  it("should throw UnauthorizedException when there is no Authorization header", async () => {
    // ARRANGE
    const { context } = buildContext();

    // ACT
    const result = guard.canActivate(context);

    // ASSERT
    await expect(result).rejects.toThrow(UnauthorizedException);
  });

  it("should throw UnauthorizedException when the header is not a Bearer token", async () => {
    // ARRANGE
    const { context } = buildContext({ authorization: "Basic abc123" });

    // ACT
    const result = guard.canActivate(context);

    // ASSERT
    await expect(result).rejects.toThrow(UnauthorizedException);
  });

  it("should throw UnauthorizedException when the token is invalid or expired", async () => {
    // ARRANGE
    const { context } = buildContext({ authorization: "Bearer bad-token" });
    mockJwtService.verifyAsync.mockRejectedValue(new Error("jwt expired"));

    // ACT
    const result = guard.canActivate(context);

    // ASSERT
    await expect(result).rejects.toThrow(UnauthorizedException);
  });

  it("should allow the request and attach the payload when the token is valid", async () => {
    // ARRANGE
    const payload = { sub: "1", email: "ana@test.com", role: "customer" };
    const { context, request } = buildContext({ authorization: "Bearer good-token" });
    mockJwtService.verifyAsync.mockResolvedValue(payload);

    // ACT
    const result = await guard.canActivate(context);

    // ASSERT
    expect(result).toBe(true);
    expect(request.user).toEqual(payload);
  });
});
