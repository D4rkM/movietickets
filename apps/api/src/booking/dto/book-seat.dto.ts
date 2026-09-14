import { IsEnum, IsString, MinLength, ValidateIf } from "class-validator";

export enum TicketType {
  FULL = "full",
  HALF = "half",
}

export class BookSeatDto {
  @IsEnum(TicketType)
  ticketType: TicketType;

  @ValidateIf((dto: BookSeatDto) => dto.ticketType === TicketType.HALF)
  @IsString()
  @MinLength(1)
  halfPriceDocument?: string;
}
