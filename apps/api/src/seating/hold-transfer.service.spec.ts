import { Test } from "@nestjs/testing";
import { VALKEY } from "../valkey/valkey.module";
import {
  HoldTransferService,
  RELEASE_IF_OWNED_SCRIPT,
  selectOldestHoldsToRelease,
  TRANSFER_GUEST_HOLDS_SCRIPT,
} from "./hold-transfer.service";
import { SeatingGateway } from "./seating.gateway";

describe("selectOldestHoldsToRelease", () => {
  const holds = [
    { key: "seat-hold:s1:newest", pttl: 590_000 },
    { key: "seat-hold:s1:oldest", pttl: 100_000 },
    { key: "seat-hold:s1:middle", pttl: 300_000 },
    { key: "seat-hold:s1:older", pttl: 200_000 },
  ];

  it.each([
    [0, []],
    [2, []],
    [3, ["seat-hold:s1:oldest"]],
    [4, ["seat-hold:s1:oldest", "seat-hold:s1:older"]],
    [6, ["seat-hold:s1:oldest", "seat-hold:s1:older", "seat-hold:s1:middle", "seat-hold:s1:newest"]],
  ])("should release the lowest-PTTL holds when %i guest seats are kept", (keptCount, expectedKeys) => {
    // ACT
    const result = selectOldestHoldsToRelease(holds, keptCount, 6);

    // ASSERT
    expect(result.map((hold) => hold.key)).toEqual(expectedKeys);
  });

  it("should not mutate the input order", () => {
    // ARRANGE
    const input = [...holds];

    // ACT
    selectOldestHoldsToRelease(input, 4, 6);

    // ASSERT
    expect(input).toEqual(holds);
  });
});

describe("transfer Lua scripts", () => {
  it("should only rewrite a hold whose current owner is the guest, preserving its TTL with KEEPTTL", () => {
    // ASSERT
    expect(TRANSFER_GUEST_HOLDS_SCRIPT).toContain('if holder == ARGV[1] then');
    expect(TRANSFER_GUEST_HOLDS_SCRIPT).toContain('redis.call("SET", key, ARGV[2], "KEEPTTL")');
    expect(TRANSFER_GUEST_HOLDS_SCRIPT).not.toMatch(/"EX"|"PX"|EXPIRE/);
  });

  it("should only delete a hold that is still owned by the user", () => {
    // ASSERT
    expect(RELEASE_IF_OWNED_SCRIPT).toContain('if redis.call("GET", key) == ARGV[1] then');
  });
});

describe("HoldTransferService", () => {
  const mockPipeline = { pttl: jest.fn(), exec: jest.fn() };
  const mockValkey = {
    set: jest.fn(),
    smembers: jest.fn(),
    eval: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(),
  };
  const mockGateway = { broadcastSeatUpdate: jest.fn() };
  const tokenExp = Math.floor(Date.now() / 1000) + 3600;

  let service: HoldTransferService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockValkey.set.mockResolvedValue("OK");
    mockValkey.smembers.mockResolvedValue([]);
    mockValkey.scan.mockResolvedValue(["0", []]);
    mockValkey.mget.mockResolvedValue([]);
    mockValkey.pipeline.mockReturnValue(mockPipeline);
    mockPipeline.exec.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        HoldTransferService,
        { provide: VALKEY, useValue: mockValkey },
        { provide: SeatingGateway, useValue: mockGateway },
      ],
    }).compile();

    service = moduleRef.get(HoldTransferService);
  });

  it("should skip the transfer when the guest was already consumed", async () => {
    // ARRANGE
    mockValkey.set.mockResolvedValue(null);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(result).toBeUndefined();
    expect(mockValkey.smembers).not.toHaveBeenCalled();
    expect(mockValkey.eval).not.toHaveBeenCalled();
  });

  it("should claim the guest with SET NX and a TTL equal to the token's remaining lifetime", async () => {
    // ACT
    await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    const [key, value, mode, seconds, flag] = mockValkey.set.mock.calls[0];
    expect([key, value, mode, flag]).toEqual(["guest-consumed:g1", "1", "EX", "NX"]);
    expect(seconds).toBeGreaterThan(3590);
    expect(seconds).toBeLessThanOrEqual(3600);
  });

  it("should return an empty report and drop the index when the guest has no holds", async () => {
    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(result).toEqual({ keptSeats: [], releasedSeats: [] });
    expect(mockValkey.eval).not.toHaveBeenCalled();
    expect(mockValkey.del).toHaveBeenCalledWith("guest-holds:g1");
  });

  it("should run the CAS script over every indexed hold, keep transferred ones and report expired ones", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["s1:a1", "s1:a2", "s1:a3"]);
    mockValkey.eval.mockResolvedValueOnce(["transferred", "expired", "owned"]);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.eval).toHaveBeenCalledWith(
      TRANSFER_GUEST_HOLDS_SCRIPT,
      3,
      "seat-hold:s1:a1",
      "seat-hold:s1:a2",
      "seat-hold:s1:a3",
      "guest:g1",
      "user-1",
    );
    expect(result).toEqual({
      keptSeats: [
        { sessionId: "s1", seatId: "a1" },
        { sessionId: "s1", seatId: "a3" },
      ],
      releasedSeats: [{ sessionId: "s1", seatId: "a2", reason: "expired" }],
    });
    expect(mockValkey.del).toHaveBeenCalledWith("guest-holds:g1");
  });

  it("should broadcast 'held' with the new owner only for seats that actually changed owner", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["s1:a1", "s1:a2", "s1:a3"]);
    mockValkey.eval.mockResolvedValueOnce(["transferred", "expired", "owned"]);

    // ACT
    await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledTimes(1);
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("s1", {
      seatId: "a1",
      status: "held",
      heldByUserId: "user-1",
    });
  });

  it("should ignore malformed index members", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["garbage", "s1:a1"]);
    mockValkey.eval.mockResolvedValueOnce(["transferred"]);

    // ACT
    await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.eval).toHaveBeenCalledWith(TRANSFER_GUEST_HOLDS_SCRIPT, 1, "seat-hold:s1:a1", "guest:g1", "user-1");
  });

  it("should release the user's oldest holds (lowest PTTL) in that session until the total is 6, and broadcast 'released'", async () => {
    // ARRANGE: 4 guest seats kept + 4 pre-existing user holds in s1
    mockValkey.smembers.mockResolvedValue(["s1:g1", "s1:g2", "s1:g3", "s1:g4"]);
    mockValkey.eval
      .mockResolvedValueOnce(["transferred", "transferred", "transferred", "transferred"])
      .mockResolvedValueOnce(["seat-hold:s1:u-oldest", "seat-hold:s1:u-older"]);
    mockValkey.scan.mockResolvedValue([
      "0",
      [
        "seat-hold:s1:g1",
        "seat-hold:s1:g2",
        "seat-hold:s1:g3",
        "seat-hold:s1:g4",
        "seat-hold:s1:u-newest",
        "seat-hold:s1:u-oldest",
        "seat-hold:s1:u-newer",
        "seat-hold:s1:u-older",
        "seat-hold:s1:someone-else",
      ],
    ]);
    mockValkey.mget.mockResolvedValue(["user-1", "user-1", "user-1", "user-1", "other-user"]);
    mockPipeline.exec.mockResolvedValue([
      [null, 590_000],
      [null, 100_000],
      [null, 500_000],
      [null, 200_000],
    ]);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.mget).toHaveBeenCalledWith(
      "seat-hold:s1:u-newest",
      "seat-hold:s1:u-oldest",
      "seat-hold:s1:u-newer",
      "seat-hold:s1:u-older",
      "seat-hold:s1:someone-else",
    );
    expect(mockValkey.eval).toHaveBeenLastCalledWith(
      RELEASE_IF_OWNED_SCRIPT,
      2,
      "seat-hold:s1:u-oldest",
      "seat-hold:s1:u-older",
      "user-1",
    );
    expect(result?.keptSeats).toHaveLength(4);
    expect(result?.releasedSeats).toEqual([
      { sessionId: "s1", seatId: "u-oldest", reason: "limit" },
      { sessionId: "s1", seatId: "u-older", reason: "limit" },
    ]);
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("s1", { seatId: "u-oldest", status: "released" });
    expect(mockGateway.broadcastSeatUpdate).toHaveBeenCalledWith("s1", { seatId: "u-older", status: "released" });
  });

  it("should only report seats the CAS release actually deleted", async () => {
    // ARRANGE: one of the two oldest holds changed hands before the release ran
    mockValkey.smembers.mockResolvedValue(["s1:g1", "s1:g2", "s1:g3", "s1:g4", "s1:g5"]);
    mockValkey.eval
      .mockResolvedValueOnce(["transferred", "transferred", "transferred", "transferred", "transferred"])
      .mockResolvedValueOnce([]);
    mockValkey.scan.mockResolvedValue(["0", ["seat-hold:s1:u1", "seat-hold:s1:u2"]]);
    mockValkey.mget.mockResolvedValue(["user-1", "user-1"]);
    mockPipeline.exec.mockResolvedValue([
      [null, 400_000],
      [null, 300_000],
    ]);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.eval).toHaveBeenLastCalledWith(RELEASE_IF_OWNED_SCRIPT, 1, "seat-hold:s1:u2", "user-1");
    expect(result?.releasedSeats).toEqual([]);
  });

  it("should not release anything when the user stays within the limit", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["s1:g1"]);
    mockValkey.eval.mockResolvedValueOnce(["transferred"]);
    mockValkey.scan.mockResolvedValue(["0", ["seat-hold:s1:g1", "seat-hold:s1:u1"]]);
    mockValkey.mget.mockResolvedValue(["user-1"]);
    mockPipeline.exec.mockResolvedValue([[null, 400_000]]);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.eval).toHaveBeenCalledTimes(1);
    expect(result?.releasedSeats).toEqual([]);
  });

  it("should only check sessions that received guest seats, never scanning other sessions", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["s1:g1", "s2:g2"]);
    mockValkey.eval.mockResolvedValueOnce(["transferred", "expired"]);

    // ACT
    await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.scan).toHaveBeenCalledTimes(1);
    expect(mockValkey.scan).toHaveBeenCalledWith("0", "MATCH", "seat-hold:s1:*", "COUNT", 100);
  });

  it("should ignore holds that vanished between the owner check and the PTTL read", async () => {
    // ARRANGE
    mockValkey.smembers.mockResolvedValue(["s1:g1", "s1:g2", "s1:g3", "s1:g4", "s1:g5", "s1:g6"]);
    mockValkey.eval.mockResolvedValueOnce(Array.from({ length: 6 }, () => "transferred"));
    mockValkey.scan.mockResolvedValue(["0", ["seat-hold:s1:u1"]]);
    mockValkey.mget.mockResolvedValue(["user-1"]);
    mockPipeline.exec.mockResolvedValue([[null, -2]]);

    // ACT
    const result = await service.transferGuestHolds("g1", "user-1", tokenExp);

    // ASSERT
    expect(mockValkey.eval).toHaveBeenCalledTimes(1);
    expect(result?.releasedSeats).toEqual([]);
  });
});
