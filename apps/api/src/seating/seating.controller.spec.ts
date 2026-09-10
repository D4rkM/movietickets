import { FastifyRequest } from "fastify";
import { SeatingController } from "./seating.controller";
import { SeatingService } from "./seating.service";

describe("SeatingController", () => {
  const mockSeatingService = { getSeatMap: jest.fn() };
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
});
