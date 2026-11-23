import { NotFoundException } from "@nestjs/common";
import { areTestRoutesEnabled, TestRoutesGuard } from "./test-routes.guard";

describe("areTestRoutesEnabled", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["1", false],
    ["TRUE", false],
    ["", false],
    [undefined, false],
  ])("should return the right answer when ENABLE_TEST_ROUTES is %p", (value, expected) => {
    // ARRANGE
    const env = { ENABLE_TEST_ROUTES: value } as NodeJS.ProcessEnv;

    // ACT
    const result = areTestRoutesEnabled(env);

    // ASSERT
    expect(result).toBe(expected);
  });
});

describe("TestRoutesGuard", () => {
  const original = process.env.ENABLE_TEST_ROUTES;

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_TEST_ROUTES;
    else process.env.ENABLE_TEST_ROUTES = original;
  });

  it("should throw NotFoundException when the flag is not set", () => {
    // ARRANGE
    delete process.env.ENABLE_TEST_ROUTES;

    // ACT
    const act = () => new TestRoutesGuard().canActivate();

    // ASSERT
    expect(act).toThrow(NotFoundException);
  });

  it("should allow the request when the flag is true", () => {
    // ARRANGE
    process.env.ENABLE_TEST_ROUTES = "true";

    // ACT
    const result = new TestRoutesGuard().canActivate();

    // ASSERT
    expect(result).toBe(true);
  });
});
