import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Matches, Min, ValidateIf } from "class-validator";
import { IsFutureDate } from "../../shared/is-future-date.validator";

/** ISO 8601 date-time that carries an explicit offset (`Z` or `±HH:MM`), so the instant is unambiguous. */
export const ISO_DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const OFFSET_MESSAGE = "startsAt precisa estar em ISO 8601 com fuso (ex: 2026-12-20T19:00:00-03:00)";

export class CreateSessionDto {
  @IsUUID()
  movieId: string;

  @IsUUID()
  roomId: string;

  @IsISO8601({ strict: true })
  @Matches(ISO_DATE_TIME_WITH_OFFSET, { message: OFFSET_MESSAGE })
  @IsFutureDate()
  startsAt: string;

  @IsInt()
  @Min(1)
  priceCents: number;
}

/** Partial update: any field can be omitted, none can be nulled. */
export class UpdateSessionDto {
  @ValidateIf((_dto, value) => value !== undefined)
  @IsUUID()
  movieId?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsUUID()
  roomId?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(ISO_DATE_TIME_WITH_OFFSET, { message: OFFSET_MESSAGE })
  @IsFutureDate()
  startsAt?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @Min(1)
  priceCents?: number;
}

export class ListSessionsQueryDto {
  /** "true" also lists sessions that already started; default is upcoming only. */
  @IsOptional()
  @IsIn(["true", "false"])
  includePast?: string;
}
