import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtPayload } from "./jwt-payload.type";
import { RolesGuard } from "./roles.guard";

function buildContext(user?: JwtPayload): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  const mockReflector = { getAllAndOverride: jest.fn() };
  let guard: RolesGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new RolesGuard(mockReflector as unknown as Reflector);
  });

  it.each([
    ["no @Roles metadata", undefined],
    ["an empty @Roles list", []],
  ])("should allow the request when the route has %s", (_label, roles) => {
    // ARRANGE
    mockReflector.getAllAndOverride.mockReturnValue(roles);

    // ACT
    const result = guard.canActivate(buildContext());

    // ASSERT
    expect(result).toBe(true);
  });

  it.each([
    ["a user token with kind 'user'", { kind: "user", sub: "1", email: "a@test.com", role: "admin" }],
    ["a legacy user token without kind", { sub: "1", email: "a@test.com", role: "admin" }],
  ] as [string, JwtPayload][])("should allow an admin with %s", (_label, user) => {
    // ARRANGE
    mockReflector.getAllAndOverride.mockReturnValue(["admin"]);

    // ACT
    const result = guard.canActivate(buildContext(user));

    // ASSERT
    expect(result).toBe(true);
  });

  it.each([
    ["a customer", { kind: "user", sub: "1", email: "c@test.com", role: "customer" }],
    ["a guest", { kind: "guest", sub: "guest:abc" }],
  ] as [string, JwtPayload][])("should reject %s with ForbiddenException", (_label, user) => {
    // ARRANGE
    mockReflector.getAllAndOverride.mockReturnValue(["admin"]);

    // ACT
    const act = () => guard.canActivate(buildContext(user));

    // ASSERT
    expect(act).toThrow(ForbiddenException);
  });

  it("should reject with UnauthorizedException when there is no request.user", () => {
    // ARRANGE
    mockReflector.getAllAndOverride.mockReturnValue(["admin"]);

    // ACT
    const act = () => guard.canActivate(buildContext(undefined));

    // ASSERT
    expect(act).toThrow(UnauthorizedException);
  });
});
