import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcrypt";
import { DRIZZLE } from "../db/drizzle.module";
import { HoldTransferService } from "../seating/hold-transfer.service";
import { AuthService } from "./auth.service";

jest.mock("bcrypt");

describe("AuthService", () => {
  const mockDb = {
    query: { users: { findFirst: jest.fn() } },
    insert: jest.fn(),
  };
  const mockJwtService = {
    sign: jest.fn().mockReturnValue("signed-token"),
    decode: jest.fn(),
    verifyAsync: jest.fn(),
  };
  const mockHoldTransferService = { transferGuestHolds: jest.fn() };

  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: JwtService, useValue: mockJwtService },
        { provide: HoldTransferService, useValue: mockHoldTransferService },
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
    const storedUser = {
      id: "1",
      name: "Ana",
      email: "ana@test.com",
      passwordHash: "hashed-password",
      role: "customer",
    };

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
    it("should sign the access token with kind 'user'", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      // ACT
      await service.login({ email: "ana@test.com", password: "password123" });

      // ASSERT
      expect(mockJwtService.sign).toHaveBeenCalledWith({
        kind: "user",
        sub: "1",
        email: "ana@test.com",
        role: "customer",
      });
    });

    it("should not look at the guest token nor transfer holds when the password is wrong", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      // ACT
      const result = service.login({ email: "ana@test.com", password: "wrong", guestToken: "guest-token" });

      // ASSERT
      await expect(result).rejects.toThrow(UnauthorizedException);
      expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();
      expect(mockHoldTransferService.transferGuestHolds).not.toHaveBeenCalled();
    });

    it("should transfer the guest holds and report them when a valid guest token is sent", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.verifyAsync.mockResolvedValue({ kind: "guest", sub: "guest:abc", exp: 1_900_000_000 });
      const transfer = {
        keptSeats: [{ sessionId: "session-1", seatId: "seat-1" }],
        releasedSeats: [{ sessionId: "session-1", seatId: "seat-2", reason: "expired" }],
      };
      mockHoldTransferService.transferGuestHolds.mockResolvedValue(transfer);

      // ACT
      const result = await service.login({ email: "ana@test.com", password: "password123", guestToken: "guest-token" });

      // ASSERT
      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith("guest-token");
      expect(mockHoldTransferService.transferGuestHolds).toHaveBeenCalledWith("abc", "1", 1_900_000_000);
      expect(result).toEqual(expect.objectContaining({ accessToken: "signed-token", transfer }));
    });

    it.each([
      ["a user-kind token", { kind: "user", sub: "user-9", email: "x@test.com", role: "customer", exp: 1 }],
      ["a legacy token without kind", { sub: "user-9", email: "x@test.com", role: "customer", exp: 1 }],
      ["a guest token with a malformed subject", { kind: "guest", sub: "not-a-guest", exp: 1 }],
      ["a guest token without exp", { kind: "guest", sub: "guest:abc" }],
    ])("should skip the transfer and omit 'transfer' when the guest token is %s", async (_label, payload) => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.verifyAsync.mockResolvedValue(payload);

      // ACT
      const result = await service.login({ email: "ana@test.com", password: "password123", guestToken: "token" });

      // ASSERT
      expect(mockHoldTransferService.transferGuestHolds).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty("transfer");
      expect(result.accessToken).toBe("signed-token");
    });

    it("should skip the transfer when the guest token fails verification (invalid or expired)", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.verifyAsync.mockRejectedValue(new Error("jwt expired"));

      // ACT
      const result = await service.login({ email: "ana@test.com", password: "password123", guestToken: "bad" });

      // ASSERT
      expect(mockHoldTransferService.transferGuestHolds).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty("transfer");
    });

    it("should omit 'transfer' when the guest token was already consumed", async () => {
      // ARRANGE
      mockDb.query.users.findFirst.mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.verifyAsync.mockResolvedValue({ kind: "guest", sub: "guest:abc", exp: 1_900_000_000 });
      mockHoldTransferService.transferGuestHolds.mockResolvedValue(undefined);

      // ACT
      const result = await service.login({ email: "ana@test.com", password: "password123", guestToken: "used" });

      // ASSERT
      expect(result).not.toHaveProperty("transfer");
    });
  });

  describe("issueGuestToken", () => {
    it("should sign a 2h guest token with kind 'guest' and a guest:<uuid> subject", () => {
      // ARRANGE
      mockJwtService.sign.mockReturnValueOnce("guest-token");
      mockJwtService.decode.mockReturnValue({ exp: 1_900_000_000 });

      // ACT
      const result = service.issueGuestToken();

      // ASSERT
      const [payload, options] = mockJwtService.sign.mock.calls[0];
      expect(payload).toEqual({ kind: "guest", sub: expect.stringMatching(/^guest:[0-9a-f-]{36}$/) });
      expect(options).toEqual({ expiresIn: 7200 });
      expect(result).toEqual({ guestToken: "guest-token", expiresAt: new Date(1_900_000_000 * 1000).toISOString() });
    });

    it("should issue a different guest identity on every call", () => {
      // ARRANGE
      mockJwtService.decode.mockReturnValue({ exp: 1_900_000_000 });

      // ACT
      service.issueGuestToken();
      service.issueGuestToken();

      // ASSERT
      const [first, second] = mockJwtService.sign.mock.calls.map(([payload]) => payload.sub);
      expect(first).not.toBe(second);
    });
  });
});
