import { IsEmail, IsOptional, IsString } from "class-validator";

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  /**
   * Guest token held by the visitor before logging in. Declared explicitly so
   * the global ValidationPipe (`whitelist: true`) doesn't strip it.
   */
  @IsOptional()
  @IsString()
  guestToken?: string;
}
