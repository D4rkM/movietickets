import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min, ValidateIf } from "class-validator";
import { Trim } from "../../shared/trim.transform";
import { MAX_ROOM_ROWS, MAX_SEATS_PER_ROW } from "../seat-layout";

export class CreateRoomDto {
  @IsUUID()
  cinemaId: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  @Min(1)
  @Max(MAX_ROOM_ROWS)
  rows: number;

  @IsInt()
  @Min(1)
  @Max(MAX_SEATS_PER_ROW)
  seatsPerRow: number;
}

/**
 * Partial update. `cinemaId` is not accepted here (moving a room to another
 * cinema isn't allowed): the global ValidationPipe strips it like any other
 * undeclared field.
 */
export class UpdateRoomDto {
  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_ROOM_ROWS)
  rows?: number;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_SEATS_PER_ROW)
  seatsPerRow?: number;
}

export class ListRoomsQueryDto {
  @IsOptional()
  @IsUUID()
  cinemaId?: string;
}
