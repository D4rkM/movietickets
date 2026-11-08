import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

describe("AuthController", () => {
  const mockAuthService = { register: jest.fn(), login: jest.fn(), issueGuestToken: jest.fn() };
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(mockAuthService as unknown as AuthService);
  });

  it("should delegate register to AuthService", async () => {
    // ARRANGE
    const dto = { name: "Ana", email: "ana@test.com", password: "password123" };
    const createdUser = { id: "1", name: "Ana", email: "ana@test.com", role: "customer" };
    mockAuthService.register.mockResolvedValue(createdUser);

    // ACT
    const result = await controller.register(dto);

    // ASSERT
    expect(mockAuthService.register).toHaveBeenCalledWith(dto);
    expect(result).toEqual(createdUser);
  });

  it("should delegate login to AuthService", async () => {
    // ARRANGE
    const dto = { email: "ana@test.com", password: "password123" };
    mockAuthService.login.mockResolvedValue({ accessToken: "token" });

    // ACT
    const result = await controller.login(dto);

    // ASSERT
    expect(mockAuthService.login).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ accessToken: "token" });
  });

  it("should delegate guest token issuing to AuthService", () => {
    // ARRANGE
    const issued = { guestToken: "guest-token", expiresAt: "2026-11-08T12:00:00.000Z" };
    mockAuthService.issueGuestToken.mockReturnValue(issued);

    // ACT
    const result = controller.issueGuestToken();

    // ASSERT
    expect(mockAuthService.issueGuestToken).toHaveBeenCalled();
    expect(result).toEqual(issued);
  });
});
