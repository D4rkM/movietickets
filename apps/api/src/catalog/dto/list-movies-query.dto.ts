import { IsDateString, IsOptional, IsString, IsUUID } from "class-validator";

export class ListMoviesQueryDto {
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsUUID()
  cinemaId?: string;

  /** ISO date (YYYY-MM-DD) — restricts sessions to that calendar day (UTC). */
  @IsOptional()
  @IsDateString()
  date?: string;
}
