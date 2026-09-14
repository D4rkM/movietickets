// class-transformer's @Type() decorator reads design-time metadata via
// Reflect.getMetadata at class-declaration time; running this spec in
// isolation (no @nestjs/testing import pulling in @nestjs/core) needs the
// polyfill loaded before book-seats.dto.ts is imported below.
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TicketType } from "./book-seat.dto";
import { BookSeatsDto } from "./book-seats.dto";

describe("BookSeatsDto", () => {
  it("should be valid for a list of full tickets", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatsDto, {
      seats: [
        { seatId: "seat-1", ticketType: TicketType.FULL },
        { seatId: "seat-2", ticketType: TicketType.FULL },
      ],
    });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });

  it("should be invalid when seats is empty", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatsDto, { seats: [] });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors.some((error) => error.property === "seats")).toBe(true);
  });

  it("should be invalid when one of the seats is a half ticket with no document", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatsDto, {
      seats: [
        { seatId: "seat-1", ticketType: TicketType.FULL },
        { seatId: "seat-2", ticketType: TicketType.HALF },
      ],
    });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).not.toHaveLength(0);
  });

  it("should be valid when a half ticket has a document", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatsDto, {
      seats: [{ seatId: "seat-1", ticketType: TicketType.HALF, halfPriceDocument: "1234567890" }],
    });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });
});
