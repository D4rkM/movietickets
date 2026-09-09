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
    it("throws ConflictException when email already exists", async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: "1" });

      await expect(
        service.register({ name: "Ana", email: "ana@test.com", password: "password123" }),
      ).rejects.toThrow(ConflictException);
    });

    it("hashes the password and returns an access token", async () => {
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

      const result = await service.register({
        name: "Ana",
        email: "ana@test.com",
        password: "password123",
      });

      expect(bcrypt.hash).toHaveBeenCalledWith("password123", 10);
      expect(result.accessToken).toBe("signed-token");
      expect(result.user).toEqual({
        id: "1",
        name: "Ana",
        email: "ana@test.com",
        role: "customer",
      });
    });
  });

  describe("login", () => {
    it("throws UnauthorizedException when user does not exist", async () => {
      mockDb.query.users.findFirst.mockResolvedValue(undefined);

      await expect(
        service.login({ email: "ghost@test.com", password: "password123" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when password does not match", async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: "1",
        email: "ana@test.com",
        passwordHash: "hashed-password",
        role: "customer",
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: "ana@test.com", password: "wrong" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("returns an access token on valid credentials", async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: "1",
        name: "Ana",
        email: "ana@test.com",
        passwordHash: "hashed-password",
        role: "customer",
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login({ email: "ana@test.com", password: "password123" });

      expect(result.accessToken).toBe("signed-token");
    });
  });
});
