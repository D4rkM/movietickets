import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { JwtPayload } from "./jwt-payload.type";
import { UserOrGuestAuthGuard } from "./user-or-guest-auth.guard";

type FakeRequest = { headers: Record<string, string>; user?: JwtPayload };

function buildContext(headers: Record<string, string> = {}): { context: ExecutionContext; request: FakeRequest } {
  const request: FakeRequest = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("UserOrGuestAuthGuard", () => {
  const mockJwtService = { verifyAsync: jest.fn() };
  let guard: UserOrGuestAuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new UserOrGuestAuthGuard(mockJwtService as unknown as JwtService);
  });

  it.each([
    ["no Authorization header", {}],
    ["a non-Bearer header", { authorization: "Basic abc123" }],
  ])("should throw UnauthorizedException when there is %s", async (_label, headers) => {
    // ARRANGE
    const { context } = buildContext(headers);

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

  it.each([
    ["a guest token", { kind: "guest", sub: "guest:3f1c" }],
    ["a user token", { kind: "user", sub: "1", email: "ana@test.com", role: "customer" }],
    ["a legacy user token without kind", { sub: "1", email: "ana@test.com", role: "customer" }],
  ])("should accept %s and attach its payload", async (_label, payload) => {
    // ARRANGE
    const { context, request } = buildContext({ authorization: "Bearer token" });
    mockJwtService.verifyAsync.mockResolvedValue(payload);

    // ACT
    const result = await guard.canActivate(context);

    // ASSERT
    expect(result).toBe(true);
    expect(request.user).toEqual(payload);
  });

  it.each([
    ["a guest token whose subject lacks the guest: prefix", { kind: "guest", sub: "3f1c" }],
    ["a guest token with an empty guest id", { kind: "guest", sub: "guest:" }],
    ["a token with an unknown kind", { kind: "admin", sub: "1" }],
  ])("should reject %s", async (_label, payload) => {
    // ARRANGE
    const { context, request } = buildContext({ authorization: "Bearer token" });
    mockJwtService.verifyAsync.mockResolvedValue(payload);

    // ACT
    const result = guard.canActivate(context);

    // ASSERT
    await expect(result).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });
});
