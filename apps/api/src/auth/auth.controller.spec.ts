import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

describe("AuthController", () => {
  const mockAuthService = { register: jest.fn(), login: jest.fn() };
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(mockAuthService as unknown as AuthService);
  });

  it("delegates register to AuthService", async () => {
    const dto = { name: "Ana", email: "ana@test.com", password: "password123" };
    mockAuthService.register.mockResolvedValue({ accessToken: "token" });

    const result = await controller.register(dto);

    expect(mockAuthService.register).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ accessToken: "token" });
  });

  it("delegates login to AuthService", async () => {
    const dto = { email: "ana@test.com", password: "password123" };
    mockAuthService.login.mockResolvedValue({ accessToken: "token" });

    const result = await controller.login(dto);

    expect(mockAuthService.login).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ accessToken: "token" });
  });
});
