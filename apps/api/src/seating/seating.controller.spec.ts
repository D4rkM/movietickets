import { FastifyRequest } from "fastify";
import { SeatingController } from "./seating.controller";
import { SeatingService } from "./seating.service";

describe("SeatingController", () => {
  const mockSeatingService = {
    getSeatMap: jest.fn(),
    holdSeat: jest.fn(),
    releaseSeat: jest.fn(),
    releaseAllHoldsForUser: jest.fn(),
  };
  let controller: SeatingController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SeatingController(mockSeatingService as unknown as SeatingService);
  });

  it("should delegate to SeatingService with the session id and requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockSeatingService.getSeatMap.mockResolvedValue({ room: { rows: 1, seatsPerRow: 1 }, priceCents: 1000, seats: [] });

    // ACT
    const result = await controller.getSeatMap("session-1", request);

    // ASSERT
    expect(mockSeatingService.getSeatMap).toHaveBeenCalledWith("session-1", "user-1");
    expect(result).toEqual({ room: { rows: 1, seatsPerRow: 1 }, priceCents: 1000, seats: [] });
  });

  it("should delegate holdSeat to SeatingService with the session, seat and requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockSeatingService.holdSeat.mockResolvedValue({ seatId: "seat-A1", status: "held", expiresInSeconds: 600 });

    // ACT
    const result = await controller.holdSeat("session-1", "seat-A1", request);

    // ASSERT
    expect(mockSeatingService.holdSeat).toHaveBeenCalledWith("session-1", "seat-A1", "user-1");
    expect(result).toEqual({ seatId: "seat-A1", status: "held", expiresInSeconds: 600 });
  });

  it("should delegate releaseSeat to SeatingService with the session, seat and requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockSeatingService.releaseSeat.mockResolvedValue({ seatId: "seat-A1", released: true });

    // ACT
    const result = await controller.releaseSeat("session-1", "seat-A1", request);

    // ASSERT
    expect(mockSeatingService.releaseSeat).toHaveBeenCalledWith("session-1", "seat-A1", "user-1");
    expect(result).toEqual({ seatId: "seat-A1", released: true });
  });

  it("should delegate releaseAllHolds to SeatingService with the session and requesting user", async () => {
    // ARRANGE
    const request = { user: { sub: "user-1", email: "ana@test.com", role: "customer" } } as FastifyRequest;
    mockSeatingService.releaseAllHoldsForUser.mockResolvedValue({ releasedSeatIds: ["seat-A1", "seat-B1"] });

    // ACT
    const result = await controller.releaseAllHolds("session-1", request);

    // ASSERT
    expect(mockSeatingService.releaseAllHoldsForUser).toHaveBeenCalledWith("session-1", "user-1");
    expect(result).toEqual({ releasedSeatIds: ["seat-A1", "seat-B1"] });
  });
});
