import { IsNotEmpty, IsString, ValidateIf } from "class-validator";
import { Trim } from "../../shared/trim.transform";

export class CreateCinemaDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  name: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  address: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  city: string;
}

/** Partial update: any field can be omitted, none can be emptied or nulled. */
export class UpdateCinemaDto {
  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  address?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  city?: string;
}
