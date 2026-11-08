import { IsIn, IsInt, IsOptional, IsString, IsUrl, Length, Max, Min, ValidateIf } from "class-validator";
import { Trim } from "../../shared/trim.transform";

/** Brazilian age rating ("classificação indicativa"). */
export const MOVIE_RATINGS = ["L", "10", "12", "14", "16", "18"] as const;
export const MIN_MOVIE_DURATION_MINUTES = 1;
export const MAX_MOVIE_DURATION_MINUTES = 600;
const POSTER_URL_OPTIONS = { protocols: ["http", "https"], require_protocol: true };

export class CreateMovieDto {
  @Trim()
  @IsString()
  @Length(1, 200)
  title: string;

  @IsOptional()
  @IsString()
  synopsis?: string | null;

  @IsInt()
  @Min(MIN_MOVIE_DURATION_MINUTES)
  @Max(MAX_MOVIE_DURATION_MINUTES)
  durationMinutes: number;

  @IsOptional()
  @IsUrl(POSTER_URL_OPTIONS)
  posterUrl?: string | null;

  @IsOptional()
  @IsIn(MOVIE_RATINGS)
  rating?: string | null;
}

/**
 * Partial update. Required fields can be omitted but not nulled; optional
 * fields accept `null` to clear them.
 */
export class UpdateMovieDto {
  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  synopsis?: string | null;

  @ValidateIf((_dto, value) => value !== undefined)
  @IsInt()
  @Min(MIN_MOVIE_DURATION_MINUTES)
  @Max(MAX_MOVIE_DURATION_MINUTES)
  durationMinutes?: number;

  @IsOptional()
  @IsUrl(POSTER_URL_OPTIONS)
  posterUrl?: string | null;

  @IsOptional()
  @IsIn(MOVIE_RATINGS)
  rating?: string | null;
}
