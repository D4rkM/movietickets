import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.module";
import { VALKEY } from "../valkey/valkey.module";
import { SeatingGateway } from "./seating.gateway";
import { SeatingService } from "./seating.service";

describe("SeatingService", () => {
  const mockDb = {
    query: {
      sessions: { findFirst: jest.fn() },
      seats: { findFirst: jest.fn() },
      bookingSeats: { findMany: jest.fn() },
    },
  };
  const mockValkey = {
    scan: jest.fn(),
    mget: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
  };
  const mockGateway = { broadcastSeatUpdate: jest.fn() };

  let service: SeatingService;

  const session = {
    id: "session-1",
    roomId: "room-1",
    priceCents: 2500,
    room: {
      rows: 2,
      seatsPerRow: 2,
      seats: [
        { id: "seat-B1", rowLabel: "B", seatNumber: 1 },
        { id: "seat-A1", rowLabel: "A", seatNumber: 1 },
        { id: "seat-A2", rowLabel: "A", seatNumber: 2 },
      ],
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.bookingSeats.findMany.mockResolvedValue([]);
    mockValkey.scan.mockResolvedValue(["0", []]);
    mockValkey.mget.mockResolvedValue([]);
    mockValkey.get.mockResolvedValue(null);
    mockValkey.set.mockResolvedValue("OK");

    const moduleRef = await Test.createTestingModule({
      providers: [
        SeatingService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: VALKEY, useValue: mockValkey },
        { provide: SeatingGateway, useValue: mockGateway },
      ],
    }).compile();

    service = moduleRef.get(SeatingService);
  });

  it("should throw NotFoundException when the session does not exist", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(undefined);

    // ACT
    const result = service.getSeatMap("missing-session", "user-1");

    // ASSERT
    await expect(result).rejects.toThrow(NotFoundException);
  });

  it("should return seats sorted by row label then seat number", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(result.seats.map((seat) => seat.id)).toEqual(["seat-A1", "seat-A2", "seat-B1"]);
    expect(result.room).toEqual({ rows: 2, seatsPerRow: 2 });
    expect(result.priceCents).toBe(2500);
  });

  it("should mark a seat as free when it has no booking and no hold", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(result.seats.find((seat) => seat.id === "seat-A1")?.status).toBe("free");
  });

  it("should mark a seat as booked only when its booking is confirmed", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);
    mockDb.query.bookingSeats.findMany.mockResolvedValue([
      { seatId: "seat-A1", booking: { status: "confirmed" } },
      { seatId: "seat-A2", booking: { status: "pending" } },
    ]);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(result.seats.find((seat) => seat.id === "seat-A1")?.status).toBe("booked");
    expect(result.seats.find((seat) => seat.id === "seat-A2")?.status).toBe("free");
  });

  it("should mark a seat as held_by_me when the hold belongs to the requesting user", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);
    mockValkey.scan.mockResolvedValue(["0", ["seat-hold:session-1:seat-A1"]]);
    mockValkey.mget.mockResolvedValue(["user-1"]);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(result.seats.find((seat) => seat.id === "seat-A1")?.status).toBe("held_by_me");
  });

  it("should mark a seat as held_by_other when the hold belongs to a different user", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);
    mockValkey.scan.mockResolvedValue(["0", ["seat-hold:session-1:seat-A1"]]);
    mockValkey.mget.mockResolvedValue(["someone-else"]);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(result.seats.find((seat) => seat.id === "seat-A1")?.status).toBe("held_by_other");
  });

  it("should follow the scan cursor until it returns to zero", async () => {
    // ARRANGE
    mockDb.query.sessions.findFirst.mockResolvedValue(session);
    mockValkey.scan
      .mockResolvedValueOnce(["17", ["seat-hold:session-1:seat-A1"]])
      .mockResolvedValueOnce(["0", ["seat-hold:session-1:seat-A2"]]);
    mockValkey.mget.mockResolvedValue(["user-1", "user-1"]);

    // ACT
    const result = await service.getSeatMap("session-1", "user-1");

    // ASSERT
    expect(mockValkey.scan).toHaveBeenCalledTimes(2);
    expect(result.seats.find((seat) => seat.id === "seat-A2")?.status).toBe("held_by_me");
  });

  describe("holdSeat", () => {
    const seat = { id: "seat-A1", roomId: "room-1", rowLabel: "A", seatNumber: 1 };

    beforeEach(() => {
      mockDb.query.sessions.findFirst.mockResolvedValue(session);
      mockDb.query.seats.findFirst.mockResolvedValue(seat);
    });

    it("should throw NotFoundException when the session does not exist", async () => {
      // ARRANGE
      mockDb.query.sessions.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = service.holdSeat("missing-session", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should throw NotFoundException when the seat does not belong to the session's room", async () => {
      // ARRANGE
      mockDb.query.seats.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = service.holdSeat("session-1", "seat-other-room", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException when the seat is already booked", async () => {
      // ARRANGE
      mockDb.query.bookingSeats.findMany.mockResolvedValue([
        { seatId: "seat-A1", booking: { status: "confirmed" } },
      ]);

      // ACT
      const result = service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException when the seat is held by another user", async () => {
      // ARRANGE
      mockValkey.get.mockResolvedValue("user-2");

      // ACT
      const result = service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(mockValkey.set).not.toHaveBeenCalled();
    });

    it("should refresh the TTL when the same user re-holds a seat they already hold", async () => {
      // ARRANGE
      mockValkey.get.mockResolvedValue("user-1");

      // ACT
      const result = await service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      expect(mockValkey.expire).toHaveBeenCalledWith("seat-hold:session-1:seat-A1", 600);
      expect(mockValkey.set).not.toHaveBeenCalled();
      expect(result).toEqual({ seatId: "seat-A1", status: "held", expiresInSeconds: 600 });
      // No state change for other clients on a same-user refresh, so no broadcast.
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
    });

    it("should throw ConflictException when the user already holds the max seats allowed", async () => {
      // ARRANGE
      mockValkey.scan.mockResolvedValue([
        "0",
        Array.from({ length: 6 }, (_, i) => `seat-hold:session-1:seat-other-${i}`),
      ]);
      mockValkey.mget.mockResolvedValue(Array.from({ length: 6 }, () => "user-1"));

      // ACT
      const result = service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(mockValkey.set).not.toHaveBeenCalled();
    });

    it("should acquire the hold with a TTL when the seat is free", async () => {
      // ACT
      const result = await service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      expect(mockValkey.set).toHaveBeenCalledWith(
        "seat-hold:session-1:seat-A1",
        "user-1",
        "EX",
        600,
        "NX",
      );
      expect(result).toEqual({ seatId: "seat-A1", status: "held", expiresInSeconds: 600 });
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
        seatId: "seat-A1",
        status: "held",
        heldByUserId: "user-1",
      });
    });

    it("should throw ConflictException when SETNX loses a race to another request", async () => {
      // ARRANGE
      mockValkey.set.mockResolvedValue(null);

      // ACT
      const result = service.holdSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(ConflictException);
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("releaseSeat", () => {
    beforeEach(() => {
      mockDb.query.sessions.findFirst.mockResolvedValue(session);
    });

    it("should throw NotFoundException when the session does not exist", async () => {
      // ARRANGE
      mockDb.query.sessions.findFirst.mockResolvedValue(undefined);

      // ACT
      const result = service.releaseSeat("missing-session", "seat-A1", "user-1");

      // ASSERT
      await expect(result).rejects.toThrow(NotFoundException);
    });

    it("should delete the hold and broadcast 'released' when the requesting user owns it", async () => {
      // ARRANGE
      mockValkey.get.mockResolvedValue("user-1");

      // ACT
      const result = await service.releaseSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      expect(mockValkey.del).toHaveBeenCalledWith("seat-hold:session-1:seat-A1");
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
        seatId: "seat-A1",
        status: "released",
      });
      expect(result).toEqual({ seatId: "seat-A1", released: true });
    });

    it("should be a silent no-op when the seat isn't held at all", async () => {
      // ARRANGE
      mockValkey.get.mockResolvedValue(null);

      // ACT
      const result = await service.releaseSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      expect(mockValkey.del).not.toHaveBeenCalled();
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ seatId: "seat-A1", released: false });
    });

    it("should be a silent no-op when the seat is held by someone else", async () => {
      // ARRANGE
      mockValkey.get.mockResolvedValue("user-2");

      // ACT
      const result = await service.releaseSeat("session-1", "seat-A1", "user-1");

      // ASSERT
      expect(mockValkey.del).not.toHaveBeenCalled();
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ seatId: "seat-A1", released: false });
    });
  });

  describe("releaseAllHoldsForUser", () => {
    it("should release only the requesting user's holds and broadcast one event per seat", async () => {
      // ARRANGE
      mockValkey.scan.mockResolvedValue([
        "0",
        ["seat-hold:session-1:seat-A1", "seat-hold:session-1:seat-A2", "seat-hold:session-1:seat-B1"],
      ]);
      mockValkey.mget.mockResolvedValue(["user-1", "user-2", "user-1"]);

      // ACT
      const result = await service.releaseAllHoldsForUser("session-1", "user-1");

      // ASSERT
      expect(mockValkey.del).toHaveBeenCalledWith(
        "seat-hold:session-1:seat-A1",
        "seat-hold:session-1:seat-B1",
      );
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(2);
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
        seatId: "seat-A1",
        status: "released",
      });
      expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("session-1", {
        seatId: "seat-B1",
        status: "released",
      });
      expect(result).toEqual({ releasedSeatIds: ["seat-A1", "seat-B1"] });
    });

    it("should do nothing when the user holds no seats in the session", async () => {
      // ARRANGE
      mockValkey.scan.mockResolvedValue(["0", ["seat-hold:session-1:seat-A1"]]);
      mockValkey.mget.mockResolvedValue(["user-2"]);

      // ACT
      const result = await service.releaseAllHoldsForUser("session-1", "user-1");

      // ASSERT
      expect(mockValkey.del).not.toHaveBeenCalled();
      expect(mockGateway.broadcastSeatUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ releasedSeatIds: [] });
    });

    it("should do nothing when there are no holds at all in the session", async () => {
      // ARRANGE
      mockValkey.scan.mockResolvedValue(["0", []]);

      // ACT
      const result = await service.releaseAllHoldsForUser("session-1", "user-1");

      // ASSERT
      expect(mockValkey.mget).not.toHaveBeenCalled();
      expect(mockValkey.del).not.toHaveBeenCalled();
      expect(result).toEqual({ releasedSeatIds: [] });
    });
  });
});
