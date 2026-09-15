import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsEnum, IsString, MinLength, ValidateIf, ValidateNested } from "class-validator";
import { TicketType } from "./book-seat.dto";

export class BookSeatItemDto {
  @IsString()
  @MinLength(1)
  seatId: string;

  @IsEnum(TicketType)
  ticketType: TicketType;

  @ValidateIf((dto: BookSeatItemDto) => dto.ticketType === TicketType.HALF)
  @IsString()
  @MinLength(1)
  halfPriceDocument?: string;
}

export class BookSeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BookSeatItemDto)
  seats: BookSeatItemDto[];
}
