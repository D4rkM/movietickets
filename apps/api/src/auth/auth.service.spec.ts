import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcrypt";
import { DRIZZLE } from "../db/drizzle.module";
import { AuthService } from "./auth.service";

jest.mock("bcrypt");

describe("AuthService", () => {
  const mockDb = {
    query: { users: { findFirst: jest.fn() } },
    insert: jest.fn(),
  };
  const mockJwtService = { sign: jest.fn().mockReturnValue("signed-token") };

  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe("register", () => {
    it("should throw ConflictException when email already exists", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue({ id: "1" });

      // ACT
      const result = service.register({ name: "Ana", email: "ana@test.com", password: "password123" });

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });

    it("should hash the password and create the user, without issuing a token", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(undefined);
      (bcrypt.hash as jest.Mock).mockResolvedValue("hashed-password");
      const insertedUser = {
        id: "1",
        name: "Ana",
        email: "ana@test.com",
        passwordHash: "hashed-password",
        role: "customer",
      };
      mockDb.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([insertedUser]),
        }),
      });

      // ACT
      const result = await service.register({
        name: "Ana",
        email: "ana@test.com",
        password: "password123",
      });

      // ASSERT
      expect(bcrypt.hash).toHaveBeenCalledWith("password123", 10);
      expect(mockJwtService.sign).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: "1",
        name: "Ana",
        email: "ana@test.com",
        role: "customer",
      });
    });
  });

  describe("login", () => {
    it("should throw UnauthorizedException when user does not exist", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = service.login({ email: "ghost@test.com", password: "password123" });

      // ASSERT
      await expect(result).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException when password does not match", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue({
        id: "1",
        email: "ana@test.com",
        passwordHash: "hashed-password",
        role: "customer",
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      // ACT
      const result = service.login({ email: "ana@test.com", password: "wrong" });

      // ASSERT
      await expect(result).rejects.toThrow(UnauthorizedException);
    });

    it("should return an access token on valid credentials", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue({
        id: "1",
        name: "Ana",
        email: "ana@test.com",
        passwordHash: "hashed-password",
        role: "customer",
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      // ACT
      const result = await service.login({ email: "ana@test.com", password: "password123" });

      // ASSERT
      expect(result.accessToken).toBe("signed-token");
    });
  });
});
