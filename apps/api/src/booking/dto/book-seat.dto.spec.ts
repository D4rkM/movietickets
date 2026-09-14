import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BookSeatDto, TicketType } from "./book-seat.dto";

describe("BookSeatDto", () => {
  it("should be valid for a full ticket with no document", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatDto, { ticketType: TicketType.FULL });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });

  it("should be invalid for a half ticket with no document", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatDto, { ticketType: TicketType.HALF });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors.some((error) => error.property === "halfPriceDocument")).toBe(true);
  });

  it("should be valid for a half ticket with a document", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatDto, {
      ticketType: TicketType.HALF,
      halfPriceDocument: "1234567890",
    });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors).toHaveLength(0);
  });

  it("should be invalid for an unknown ticket type", async () => {
    // ARRANGE
    const dto = plainToInstance(BookSeatDto, { ticketType: "vip" });

    // ACT
    const errors = await validate(dto);

    // ASSERT
    expect(errors.some((error) => error.property === "ticketType")).toBe(true);
  });
});
