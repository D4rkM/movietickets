import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { createMockBusinessMetrics } from "../../test/helpers/business-metrics-mock";
import { BusinessMetrics } from "../telemetry/business-metrics";
import { SeatingGateway } from "./seating.gateway";

describe("SeatingGateway", () => {
  const mockJwtService = { verifyAsync: jest.fn() };
  const mockServer = { to: jest.fn() };
  const mockMetrics = createMockBusinessMetrics();
  let gateway: SeatingGateway;

  function buildClient(overrides: Record<string, unknown> = {}) {
    return {
      id: "socket-1",
      connected: true,
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
      providers: [
        SeatingGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: BusinessMetrics, useValue: mockMetrics },
      ],
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
  describe("metrics", () => {
    it.each([
      ["missing_token", buildClient(), undefined],
      ["invalid_token", buildClient({ handshake: { auth: { token: "bad-token" }, headers: {} } }), new Error("invalid")],
    ])("should count a refused connection with reason %s without touching the open connections", async (reason, client, error) => {
      // ARRANGE
      if (error) mockJwtService.verifyAsync.mockRejectedValue(error);

      // ACT
      await gateway.handleConnection(client as never);
      gateway.handleDisconnect(client as never);

      // ASSERT
      expect(mockMetrics.wsConnectionRejected).toHaveBeenCalledWith(reason);
      expect(mockMetrics.wsConnectionOpened).not.toHaveBeenCalled();
      expect(mockMetrics.wsConnectionClosed).not.toHaveBeenCalled();
    });

    it("should count an accepted connection as opened and its disconnect as closed", async () => {
      // ARRANGE
      const client = buildClient({ handshake: { auth: { token: "good-token" }, headers: {} } });
      mockJwtService.verifyAsync.mockResolvedValue({ sub: "user-1", email: "a@test.com", role: "customer" });

      // ACT
      await gateway.handleConnection(client as never);
      gateway.handleDisconnect(client as never);

      // ASSERT
      expect(mockMetrics.wsConnectionOpened).toHaveBeenCalledTimes(1);
      expect(mockMetrics.wsConnectionClosed).toHaveBeenCalledTimes(1);
      expect(mockMetrics.wsConnectionRejected).not.toHaveBeenCalled();
    });

    it("should not count a client that dropped while its token was being verified", async () => {
      // ARRANGE
      const client = buildClient({ connected: false, handshake: { auth: { token: "good-token" }, headers: {} } });
      mockJwtService.verifyAsync.mockResolvedValue({ sub: "user-1", email: "a@test.com", role: "customer" });

      // ACT
      await gateway.handleConnection(client as never);
      gateway.handleDisconnect(client as never);

      // ASSERT
      expect(client.data.userId).toBeUndefined();
      expect(mockMetrics.wsConnectionOpened).not.toHaveBeenCalled();
      expect(mockMetrics.wsConnectionClosed).not.toHaveBeenCalled();
    });

    it.each(["held", "released", "booked"] as const)("should count a %s broadcast by seat status", (status) => {
      // ARRANGE
      mockServer.to.mockReturnValue({ emit: jest.fn() });

      // ACT
      gateway.broadcastSeatUpdate("session-1", { seatId: "seat-A1", status });

      // ASSERT
      expect(mockMetrics.seatBroadcast).toHaveBeenCalledWith(status);
    });
  });
});
