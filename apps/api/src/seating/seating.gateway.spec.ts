import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { SeatingGateway } from "./seating.gateway";

describe("SeatingGateway", () => {
  const mockJwtService = { verifyAsync: jest.fn() };
  const mockServer = { to: jest.fn() };
  let gateway: SeatingGateway;

  function buildClient(overrides: Record<string, unknown> = {}) {
    return {
      id: "socket-1",
      data: {} as Record<string, unknown>,
      handshake: { auth: {}, headers: {} },
      disconnect: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockServer.to.mockReturnValue({ emit: jest.fn() });

    const moduleRef = await Test.createTestingModule({
      providers: [SeatingGateway, { provide: JwtService, useValue: mockJwtService }],
    }).compile();

    gateway = moduleRef.get(SeatingGateway);
    // @ts-expect-error -- private field, set directly like Nest does via @WebSocketServer()
    gateway["server"] = mockServer;
  });

  describe("handleConnection", () => {
    it("should disconnect the client when no token is provided", async () => {
      // ARRANGE
      const client = buildClient();

      // ACT
      await gateway.handleConnection(client as never);

      // ASSERT
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(mockJwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it("should disconnect the client when the token is invalid", async () => {
      // ARRANGE
      const client = buildClient({ handshake: { auth: { token: "bad-token" }, headers: {} } });
      mockJwtService.verifyAsync.mockRejectedValue(new Error("invalid"));

      // ACT
      await gateway.handleConnection(client as never);

      // ASSERT
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it("should accept the connection and store the user id from a valid auth.token", async () => {
      // ARRANGE
      const client = buildClient({ handshake: { auth: { token: "good-token" }, headers: {} } });
      mockJwtService.verifyAsync.mockResolvedValue({ sub: "user-1", email: "a@test.com", role: "customer" });

      // ACT
      await gateway.handleConnection(client as never);

      // ASSERT
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe("user-1");
    });

    it("should accept a token passed as an Authorization header instead of auth.token", async () => {
      // ARRANGE
      const client = buildClient({
        handshake: { auth: {}, headers: { authorization: "Bearer good-token" } },
      });
      mockJwtService.verifyAsync.mockResolvedValue({ sub: "user-1", email: "a@test.com", role: "customer" });

      // ACT
      await gateway.handleConnection(client as never);

      // ASSERT
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith("good-token");
    });
  });

  describe("handleJoin / handleLeave", () => {
    it("should join the room named after the session", () => {
      // ARRANGE
      const client = buildClient();

      // ACT
      gateway.handleJoin("session-1", client as never);

      // ASSERT
      expect(client.join).toHaveBeenCalledWith("session:session-1");
    });

    it("should leave the room named after the session", () => {
      // ARRANGE
      const client = buildClient();

      // ACT
      gateway.handleLeave("session-1", client as never);

      // ASSERT
      expect(client.leave).toHaveBeenCalledWith("session:session-1");
    });
  });

  describe("broadcastSeatUpdate", () => {
    it("should emit seat:update to every client in the session's room", () => {
      // ARRANGE
      const emit = jest.fn();
      mockServer.to.mockReturnValue({ emit });

      // ACT
      gateway.broadcastSeatUpdate("session-1", { seatId: "seat-A1", status: "held", heldByUserId: "user-1" });

      // ASSERT
      expect(mockServer.to).toHaveBeenCalledWith("session:session-1");
      expect(emit).toHaveBeenCalledWith("seat:update", {
        seatId: "seat-A1",
        status: "held",
        heldByUserId: "user-1",
      });
    });
  });
});
